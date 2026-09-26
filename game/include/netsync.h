#ifndef GUARD_NETSYNC_H
#define GUARD_NETSYNC_H

// Online overworld multiplayer.
//
// The game itself has no network access. Instead it exposes a small block of
// EWRAM (gNetSync) that the host application (the web client in ../web)
// reads and writes directly through the emulator's memory:
//
//   * every frame the game increments frameCounter;
//   * while in the overworld it publishes the local player's position in
//     `local` and stamps overworldFrame;
//   * the host writes other players' positions into `remote`, and the game
//     shows each active remote player on the current map as an object event.
//
// The host locates the block by scanning emulator memory for `magic`. The
// magic string is assembled at runtime, so it only exists in RAM and never
// in the ROM image. Layout changes must bump NETSYNC_VERSION and be mirrored
// in web/js/netsync.js.

#define NETSYNC_VERSION 1
#define NETSYNC_MAGIC_LENGTH 16
#define NETSYNC_MAX_REMOTE 4
#define NETSYNC_NAME_LENGTH 8

// Object event local IDs reserved for remote players.
#define NETSYNC_LOCALID_BASE 200
#define IS_NETSYNC_LOCALID(localId) ((localId) >= NETSYNC_LOCALID_BASE && (localId) < NETSYNC_LOCALID_BASE + NETSYNC_MAX_REMOTE)

struct NetSyncPlayer
{
    /*0x00*/ u8 active;
    /*0x01*/ u8 mapGroup;
    /*0x02*/ u8 mapNum;
    /*0x03*/ u8 facing;      // DIR_*
    /*0x04*/ s16 x;          // map-local metatile coordinates (without MAP_OFFSET)
    /*0x06*/ s16 y;
    /*0x08*/ u8 elevation;
    /*0x09*/ u8 avatarFlags; // PLAYER_AVATAR_FLAG_*
    /*0x0A*/ u8 gender;
    /*0x0B*/ u8 padding;
    /*0x0C*/ u8 name[NETSYNC_NAME_LENGTH]; // game charset, EOS-terminated
}; /*size = 0x14*/

struct NetSync
{
    /*0x00*/ u8 magic[NETSYNC_MAGIC_LENGTH];
    /*0x10*/ u32 version;
    /*0x14*/ u32 frameCounter;
    /*0x18*/ u32 overworldFrame; // frameCounter at the last overworld update
    /*0x1C*/ struct NetSyncPlayer local;
    /*0x30*/ struct NetSyncPlayer remote[NETSYNC_MAX_REMOTE];
}; /*size = 0x80*/

extern struct NetSync gNetSync;

void NetSync_Init(void);
void NetSync_FrameTick(void);
void NetSync_UpdateOverworld(void);

#endif // GUARD_NETSYNC_H
