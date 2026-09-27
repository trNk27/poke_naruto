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
// Players can also talk to each other (`talk`) to start a trade or a battle
// without going to the Cable Club: see data/netsync_scripts.s.
//
// The host locates the block by scanning emulator memory for `magic`. The
// magic string is assembled at runtime, so it only exists in RAM and never
// in the ROM image. Layout changes must bump NETSYNC_VERSION and be mirrored
// in web/js/netsync.js.

#define NETSYNC_VERSION 4
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

// Talking to another player. The inviting game asks, the host takes the
// question to the other player's game and brings back the answer; once both
// players agree, both games open the link and are paired with each other.
enum {
    NETTALK_KIND_NONE,
    NETTALK_KIND_TRADE,
    NETTALK_KIND_BATTLE,
};

enum {
    NETTALK_GAME_IDLE,
    NETTALK_GAME_INVITING,  // invited remote[slot], waiting for the answer
    NETTALK_GAME_PROMPTING, // asking the player about remote[slot]'s invitation
    NETTALK_GAME_ACCEPTED,  // both agreed: linking up with remote[slot]
    NETTALK_GAME_DECLINED,  // said no to remote[slot]'s invitation
};

enum {
    NETTALK_ANSWER_NONE,
    NETTALK_ANSWER_ACCEPTED,
    NETTALK_ANSWER_DECLINED,
    NETTALK_ANSWER_BUSY,     // the other player can't answer right now
    NETTALK_ANSWER_CANCELED, // the other player canceled or left
};

struct NetTalk
{
    /*0x00*/ u8 gameState;   // NETTALK_GAME_*, written by the game
    /*0x01*/ u8 slot;        // the other player (index into remote), written by the game
    /*0x02*/ u8 kind;        // NETTALK_KIND_*, written by the game
    /*0x03*/ vu8 answer;     // NETTALK_ANSWER_*, written by the host (the game clears it before inviting)
    /*0x04*/ vu8 inviteSlot; // 1 + index into remote of a player inviting us, 0 = none; written by the host
    /*0x05*/ vu8 inviteKind; // NETTALK_KIND_*, written by the host
    /*0x06*/ u8 padding[2];
}; /*size = 0x08*/

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
    /*0x2AC*/ struct NetTalk talk;
}; /*size = 0x2B4*/

extern struct NetSync gNetSync;

void NetSync_Init(void);
void NetSync_FrameTick(void);
void NetSync_UpdateOverworld(void);
u8 NetSync_GetRemotePlayerObjectAt(s16 x, s16 y);
const u8 *NetSync_GetRemotePlayerScript(void);
bool8 NetSync_ShouldAutoConfirmLink(void);

bool8 NetLink_RingFull(const struct NetLinkRing *ring);
bool8 NetLink_RingEmpty(const struct NetLinkRing *ring);
void NetLink_DrainInbox(void);

#endif // GUARD_NETSYNC_H
