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
// The same block carries the "virtual link cable" (`link`) that replaces the
// GBA's serial port, so the Cable Club (trading and battles) works online:
// see the NetLink section in src/link.c.
//
// The host locates the block by scanning emulator memory for `magic`. The
// magic string is assembled at runtime, so it only exists in RAM and never
// in the ROM image. Layout changes must bump NETSYNC_VERSION and be mirrored
// in web/js/netsync.js.

#define NETSYNC_VERSION 3
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

// Where a remote player's sprite is on screen, so the host can draw its name.
struct NetSyncScreenPos
{
    /*0x00*/ s16 x;      // horizontal center, in GBA screen pixels
    /*0x02*/ s16 y;      // top edge
    /*0x04*/ u8 visible;
    /*0x05*/ u8 padding[3];
}; /*size = 0x08*/

// Virtual link cable. Like the real cable, the master (localId 0) drives the
// transfers: each tick it pairs its next command with the slave's next one
// and sends the resulting entry to the slave, so both games process exactly
// the same sequence of entries.
#define NETLINK_RING_SIZE 8
#define NETLINK_CMD_LENGTH 8 // CMD_LENGTH in link.h

enum {
    NETLINK_GAME_CLOSED,
    NETLINK_GAME_SEARCHING,   // link opened, looking for a partner
    NETLINK_GAME_ESTABLISHED, // connection established
};

enum {
    NETLINK_HOST_NO_PARTNER,
    NETLINK_HOST_PARTNER_SEARCHING,
    NETLINK_HOST_PARTNER_ESTABLISHED,
    NETLINK_HOST_PARTNER_LOST,
};

// Slave -> master packets carry the slave's command in cmds[0].
// Master -> slave packets are complete entries: cmds[0] from the master
// (localId 0), cmds[1] from the slave (localId 1).
struct NetLinkPacket
{
    u16 cmds[2][NETLINK_CMD_LENGTH];
}; /*size = 0x20*/

// Single producer, single consumer. `head` is only written by the producer
// and `tail` only by the consumer; both count up and wrap at 256.
struct NetLinkRing
{
    /*0x00*/ vu8 head;
    /*0x01*/ vu8 tail;
    /*0x02*/ u8 padding[2];
    /*0x04*/ struct NetLinkPacket packets[NETLINK_RING_SIZE];
}; /*size = 0x104*/

struct NetLink
{
    /*0x000*/ u8 gameState;           // NETLINK_GAME_*, written by the game
    /*0x001*/ vu8 hostState;          // NETLINK_HOST_*, written by the host
    /*0x002*/ vu8 isMaster;           // written by the host when pairing
    /*0x003*/ u8 padding;
    /*0x004*/ struct NetLinkRing outbox; // game -> host
    /*0x108*/ struct NetLinkRing inbox;  // host -> game
}; /*size = 0x20C*/

struct NetSync
{
    /*0x00*/ u8 magic[NETSYNC_MAGIC_LENGTH];
    /*0x10*/ u32 version;
    /*0x14*/ u32 frameCounter;
    /*0x18*/ u32 overworldFrame; // frameCounter at the last overworld update
    /*0x1C*/ struct NetSyncPlayer local;
    /*0x30*/ struct NetSyncPlayer remote[NETSYNC_MAX_REMOTE];
    /*0x80*/ struct NetSyncScreenPos screen[NETSYNC_MAX_REMOTE]; // written by the game
    /*0xA0*/ struct NetLink link;
}; /*size = 0x2AC*/

extern struct NetSync gNetSync;

void NetSync_Init(void);
void NetSync_FrameTick(void);
void NetSync_UpdateOverworld(void);

bool8 NetLink_RingFull(const struct NetLinkRing *ring);
bool8 NetLink_RingEmpty(const struct NetLinkRing *ring);
void NetLink_DrainInbox(void);

#endif // GUARD_NETSYNC_H
