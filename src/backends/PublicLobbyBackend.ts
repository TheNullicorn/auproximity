import {
    BackendAdapter,
    MapIdModel,
    PublicLobbyBackendModel,
    PublicLobbyRegion,
    RoomGroup
} from "../types/Backend";
import {
    AmongusClient,
    BufferReader,
    DebugOptions,
    LerpValue,
    MapID,
    MasterServers,
    MessageID,
    PacketID,
    PayloadID,
    RPCID,
    SpawnID
} from "../../amongus-protocol/ts";
import {
    GameDataMessage,
    GameDataPayload,
    GameDataToPayload,
    Payload,
    PlayerSpawn,
    RPCMessage
} from "../../amongus-protocol/ts/lib/interfaces/Packets";

export default class PublicLobbyBackend extends BackendAdapter {
    backendModel: PublicLobbyBackendModel
    constructor(backendModel: PublicLobbyBackendModel) {
        super();
        this.backendModel = backendModel;
    }

    matchServer: [
        string,
        number
    ];
    client: AmongusClient;

    playerData: {
        name: string;
        clientId: number;
        playerId: number;
        controlNetId: number;
        transformNetId: number;
    }[] = [];
    currentMap: MapID;
    shipStatusNetId = -1;
    finishedInit: boolean = false;

    async initialize(): Promise<void> {
        try {
            // Select a macthmaking server from the appropriate region.
            if (this.backendModel.region === PublicLobbyRegion.NorthAmerica) {
                this.matchServer = [...MasterServers.NA[0]];
            } else if (this.backendModel.region === PublicLobbyRegion.Europe) {
                this.matchServer = [...MasterServers.EU[0]];
            } else if (this.backendModel.region === PublicLobbyRegion.Asia) {
                this.matchServer = [...MasterServers.AS[0]];
            }

            // Try to join the game & fetch player list.
            const initSuccess = await this.tryInitGameData();
            if (!initSuccess) {
                return;
            }

            console.log(`Initialized PublicLobby Backend for game: ${this.backendModel.gameCode}`);
        } catch (err) {
            console.warn("Error in PublicLobbyBackend, disposing room: " + err);
            this.emitError(err);
        }
    }

    async destroy(): Promise<void> {
        if (this.client && this.client.socket) {
            await this.client.disconnect();
            this.client = undefined;
        }
        console.log(`Destroyed PublicLobbyBackend for game: ${this.backendModel.gameCode}`);
    }

    /**
     * Try to join the game & load the initial player list.
     * 
     * @param spawnTimeout How long (in ms) to wait for players to spawn. If they don't spawn in time, false is returned.
     * @returns Whether or not the game could be joined & loaded
     */
    private async tryInitGameData(spawnTimeout: number = 5000): Promise<boolean> {
        this.finishedInit = false;

        // Clear cache.
        this.playerData = [];
        this.shipStatusNetId = -1;

        this.client = new AmongusClient({
            debug: DebugOptions.None
        });

        // Handle packets.
        this.client.on("packet", packet => {
            if (packet.op === PacketID.Reliable || packet.op === PacketID.Unreliable) {
                packet.payloads.forEach(async payload => await this.handlePacketPayload(payload));
            }
        });

        // Try to join the game.
        const didJoin = await this.tryJoinGame(true);
        if (!didJoin) return false;

        const game = this.client.game;

        // Wait for all players to spawn in.
        let allSpawned = true;
        await Promise.race([
            game.awaitSpawns(),
            new Promise<void>((resolve) => {
                setTimeout(() => {
                    // Time out if it takes too long.
                    allSpawned = false;
                    resolve();
                }, spawnTimeout);
            })
        ]);
        this.finishedInit = true;

        // Return an error if we couldn't get all players.
        if (!allSpawned) {
            console.error("Timed out: players didn't spawn");
            this.emitError("Couldn't load the game's player list. Try again later!");
            this.client.disconnect();
            return false;
        }

        // Cache & broadcast the game's map.
        this.currentMap = game.options.mapID;
        this.emitMapChange(MapIdModel[MapID[game.options.mapID]]);

        // Cache the game's player list.
        game.clients.forEach(client => {
            const existingData = this.playerData.find(p => p.clientId === client.id);

            if (client.name !== "") {
                this.playerData.push({
                    name: client.name,
                    clientId: client.id,
                    playerId: client.Player.PlayerControl.playerId,
                    controlNetId: client.Player.PlayerControl.netid,
                    transformNetId: client.Player.CustomNetworkTransform.netid
                });
            }
        });

        // Cache & broadcast the game's host.
        this.emitHostChange(game.host.name);

        // Rejoin the game so that our player is invisible.
        this.client.disconnect();
        return this.tryJoinGame(false);
    }

    /**
     * Attempt to join a game using its code.
     * 
     * @param code The game's code.
     * @param doSpawn Whether or not to spawn a player object when joining.
     * @returns Whether or not the game was joined.
     */
    private async tryJoinGame(doSpawn: boolean): Promise<boolean> {
        // Try to connect to the server.
        try {
            await this.client.connect(this.matchServer[0], this.matchServer[1], "auprox");
        } catch (e) {
            console.error("An error occurred", e);
            this.emitError("Couldn't connect to the Among Us servers (the server may be full). Try again later!");
            return false;
        }

        // Try to join the game.
        try {
            await this.client.join(this.backendModel.gameCode, { doSpawn });
            return true;
        } catch (e) {
            console.error("Couldn't join game.", e);
            this.emitError("Couldn't join the game, make sure that the game hasn't started and there is a spot for the client!");
            this.client.disconnect();
            return false;
        }
    }

    /**
     * Internal handler for packets received from the Among Us server.
     * 
     * @param payload The message received.
     */
    private async handlePacketPayload(payload: Payload): Promise<void> {
        // If another player joins the game...
        if (payload.payloadid === PayloadID.JoinGame && payload.bound === "client" && payload.error === false) {
            const hostData = this.playerData.find(p => p.clientId === payload.hostid);

            if (hostData) {
                // Update the host client (which might've changed).
                this.emitHostChange(hostData.name);
            }
            return;
        }

        // If the game is starting...
        if (payload.payloadid === PayloadID.StartGame) {
            // Move all clients into the main group (proximity enabled).
            this.emitAllPlayerJoinGroups(RoomGroup.Main);
            return;
        }

        // If the game is over...
        if (payload.payloadid === PayloadID.EndGame) {
            // Move all clients into the spectator group (proximity disabled).
            this.emitAllPlayerJoinGroups(RoomGroup.Spectator);

            // Clear current game data.
            this.client.game = null;
            this.playerData = [];

            // Rejoin the game.
            await this.client.join(this.backendModel.gameCode, {
                doSpawn: false
            });
            return;
        }

        // If a player leaves the
        if (payload.payloadid === PayloadID.RemovePlayer) {
            // Remove the player from our local cache.
            this.playerData = this.playerData.filter(p => p.clientId !== payload.clientid);

            // If our client becomes the host...
            if (payload.clientid === this.client.clientid) {
                // Reconnect so that another player is assigned host.
                await this.client.disconnect();
                await this.client.connect(this.matchServer[0], this.matchServer[1], "auproximity");
                await this.client.join(this.backendModel.gameCode, {
                    doSpawn: false
                });
            }

            // Update the host client (which might've changed).
            const hostData = this.playerData.find(p => p.clientId === payload.hostid);
            if (hostData) {
                this.emitHostChange(hostData.name);
            }
            return;
        }

        // If something about the game changes...
        if (payload.payloadid === PayloadID.GameData || payload.payloadid === PayloadID.GameDataTo) {
            // Handle each chage.
            (payload as (GameDataPayload | GameDataToPayload)).parts.forEach(part => {
                this.handleGameDataPart(part);
            });
        }
    }

    /**
     * Internal handler for changes to the game.
     * 
     * @param part Information about the change.
     */
    private handleGameDataPart(part: GameDataMessage): void {
        // If an object is being spawned...
        if (part.type == MessageID.Spawn) {
            // If a player was spawned...
            // (if we register players before we've initialized, we risk
            // storing duplicate players)
            if (part.spawnid === SpawnID.Player && this.finishedInit) {
                const playerSpawn: PlayerSpawn = part as PlayerSpawn;
                const controlReader = new BufferReader(playerSpawn.components[0].data);
                controlReader.bool();

                // Check if we have the player cached; if not, store a new entry for them.
                const player = this.playerData.find(p => p.controlNetId === playerSpawn.components[0].netid);
                if (player) {
                    player.clientId = playerSpawn.ownerid;
                    player.playerId = controlReader.uint8();
                    player.transformNetId = playerSpawn.components[2].netid;
                } else {
                    this.playerData.push({
                        name: "",
                        clientId: playerSpawn.ownerid,
                        playerId: controlReader.uint8(),
                        controlNetId: playerSpawn.components[0].netid,
                        transformNetId: playerSpawn.components[2].netid,
                    });
                }
            }

            // If the game's map was spawned...
            if (part.spawnid === SpawnID.ShipStatus ||
                part.spawnid === SpawnID.HeadQuarters ||
                part.spawnid === SpawnID.PlanetMap ||
                part.spawnid === SpawnID.AprilShipStatus) {
                // Store the map's component ID.
                this.shipStatusNetId = part.components[0].netid;
            }
        }

        // If an action/event is called on a component...
        if (part.type == MessageID.RPC) {
            return this.handleRPC(part as RPCMessage);
        }

        /// If a component is being updated...
        if (part.type == MessageID.Data) {
            // If the update contains a player movement...
            const player = this.playerData.find(p => p.transformNetId === part.netid);
            if (player) {
                // Read the player's new position.
                const reader = new BufferReader(part.data);
                reader.uint16LE(); // <-- sequence number; we don't need it.
                const pose = {
                    x: LerpValue(reader.uint16LE() / 65535, -40, 40),
                    y: LerpValue(reader.uint16LE() / 65535, -40, 40)
                };

                // Broadcast the player's new position.
                this.emitPlayerPose(player.name, pose);
            }

            // If the updated component is the map's state...
            if (part.netid === this.shipStatusNetId) {
                const reader = new BufferReader(part.data);
                const systemsMask = reader.packed();

                // If one of the updated systems is communications...
                if ((systemsMask & (1 << 14)) != 0) {
                    let isSabotaged: boolean = false;

                    if (this.currentMap === MapID.TheSkeld || this.currentMap === MapID.Polus) {
                        isSabotaged = reader.bool();
                    } else if (this.currentMap === MapID.MiraHQ) {
                        // We don't need this info; skip it.
                        reader.bytes(reader.packed() * 2);

                        // MiraHQ comms are sabotaged if less than 2 consoles are repaired.
                        let fixedConsoles = reader.packed();
                        isSabotaged = (fixedConsoles < 2);
                    }

                    // Move players to and from "Muted" group accordingly.
                    if (isSabotaged) {
                        this.emitPlayerFromJoinGroup(RoomGroup.Main, RoomGroup.Muted);
                    } else {
                        this.emitPlayerFromJoinGroup(RoomGroup.Muted, RoomGroup.Main);
                    }
                }
            }
        }
    }

    /**
     * Internal handler for actions & events called on game objects.
     * 
     * @param rpcPart Information about the event.
     */
    private handleRPC(rpcPart: RPCMessage): void {
        // If the game's settings were updated...
        if (rpcPart.rpcid === RPCID.SyncSettings) {
            // Broadcast the change to our clients.
            return this.emitSettingsUpdate({
                crewmateVision: rpcPart.options.crewVision
            });
        }

        // If a meeting starts...
        if (rpcPart.rpcid === RPCID.StartMeeting) {
            setTimeout(() => {
                this.emitAllPlayerPoses({ x: 0, y: 0 });
            }, 2500);
            return;
        }

        // If a meeting ends...
        if (rpcPart.rpcid === RPCID.VotingComplete) {
            // If a player was voted off... (no player voted off === 0xFF)
            if (rpcPart.exiled !== 0xFF) {
                setTimeout(() => {
                    const player = this.playerData.find(p => p.playerId === rpcPart.exiled);
                    if (player) {
                        // Make the ejected player a spectator.
                        this.emitPlayerJoinGroup(player.name, RoomGroup.Spectator);
                    }
                }, 2500);
            }
            return;
        }

        // If a player was killed by an impostor...
        if (rpcPart.rpcid === RPCID.MurderPlayer) {
            // Make the murdered player a spectator.
            const player = this.playerData.find(p => p.controlNetId === rpcPart.targetnetid);
            if (player) this.emitPlayerJoinGroup(player.name, RoomGroup.Spectator);
            return;
        }

        // If a player's name changes...
        if (rpcPart.rpcid === RPCID.SetName) {
            const player = this.playerData.find(p => p.controlNetId === rpcPart.handlerid);
            if (player) {
                player.name = rpcPart.name;
            } else {
                this.playerData.push({
                    name: rpcPart.name,
                    controlNetId: rpcPart.handlerid,
                    playerId: -1,
                    clientId: -1,
                    transformNetId: -1
                });
            }
        }

        // If a player's state was updated directly...
        if (rpcPart.rpcid == RPCID.UpdateGameData) {
            for (const playerData of rpcPart.players) {
                const player = this.playerData.find(p => p.playerId === playerData.playerId);

                if (player) {
                    player.name = playerData.name;
                } else {
                    this.playerData.push({
                        name: playerData.name,
                        controlNetId: -1,
                        playerId: playerData.playerId,
                        clientId: -1,
                        transformNetId: -1
                    });
                }
            }
        }

        // If a player gets teleported...
        if (rpcPart.rpcid === RPCID.SnapTo) {
            const player = this.playerData.find(p => p.transformNetId === rpcPart.handlerid);
            if (player) {
                // Broadcast their new position.
                const pose = {
                    x: LerpValue(rpcPart.x / 65535, -40, 40),
                    y: LerpValue(rpcPart.y / 65535, -40, 40)
                };
                this.emitPlayerPose(player.name, pose);
            }
        }
    }
}