#include "global.h"
#include "characters.h"
#include "event_data.h"
#include "event_object_movement.h"
#include "field_player_avatar.h"
#include "fieldmap.h"
#include "help_system.h"
#include "link.h"
#include "main.h"
#include "netsync.h"
#include "overworld.h"
#include "quest_log.h"
#include "script.h"
#include "string_util.h"
#include "task.h"
#include "constants/maps.h"
#include "constants/event_object_movement.h"
#include "constants/event_objects.h"
#include "constants/trainer_types.h"

// Remote players further away than this (in metatiles) are not shown. These
// bounds sit inside the area kept by RemoveObjectEventsOutsideView, so an
// object is never spawned only to be culled by the camera again.
#define SPAWN_RANGE_X 8
#define SPAWN_RANGE_Y 6

// If a remote object falls further behind than this, it is moved directly to
// the target position instead of walking there.
#define TELEPORT_DISTANCE 6

#define MAGIC_XOR 0xA5

EWRAM_DATA struct NetSync gNetSync = {0};

// Set when a link started by talking takes the player to a Cable Club room;
// cleared once they are back where they were (see FinishTalkLink).
static EWRAM_DATA bool8 sReturningFromTalkLink = FALSE;

// data/netsync_scripts.s
extern const u8 NetSync_EventScript_TalkToPlayer[];
extern const u8 NetSync_EventScript_Invited[];

void QuestLog_StartRecordingInputsAfterDeferredEvent(void);

static const u8 sText_Trade[] = _("trade");
static const u8 sText_Battle[] = _("battle");

// Marks IWRAM for debugging tools, which locate it like gNetSync (the text is
// "NARUTO-IWRAM-DBG") and then read variables by their addresses in the map
// file. Not used by the web client.
u8 gNetSyncIwramMarker[NETSYNC_MAGIC_LENGTH];

// "NARUTO-NETSYNC01" XORed with MAGIC_XOR. The real string is only ever
// assembled in RAM so that scanning emulator memory finds gNetSync and not
// a copy of this table in ROM.
static const u8 sMagicXored[NETSYNC_MAGIC_LENGTH] = {
    'N' ^ MAGIC_XOR, 'A' ^ MAGIC_XOR, 'R' ^ MAGIC_XOR, 'U' ^ MAGIC_XOR,
    'T' ^ MAGIC_XOR, 'O' ^ MAGIC_XOR, '-' ^ MAGIC_XOR, 'N' ^ MAGIC_XOR,
    'E' ^ MAGIC_XOR, 'T' ^ MAGIC_XOR, 'S' ^ MAGIC_XOR, 'Y' ^ MAGIC_XOR,
    'N' ^ MAGIC_XOR, 'C' ^ MAGIC_XOR, '0' ^ MAGIC_XOR, '1' ^ MAGIC_XOR,
};

static const u8 sIwramMarkerXored[NETSYNC_MAGIC_LENGTH] = {
    'N' ^ MAGIC_XOR, 'A' ^ MAGIC_XOR, 'R' ^ MAGIC_XOR, 'U' ^ MAGIC_XOR,
    'T' ^ MAGIC_XOR, 'O' ^ MAGIC_XOR, '-' ^ MAGIC_XOR, 'I' ^ MAGIC_XOR,
    'W' ^ MAGIC_XOR, 'R' ^ MAGIC_XOR, 'A' ^ MAGIC_XOR, 'M' ^ MAGIC_XOR,
    '-' ^ MAGIC_XOR, 'D' ^ MAGIC_XOR, 'B' ^ MAGIC_XOR, 'G' ^ MAGIC_XOR,
};

void NetSync_Init(void)
{
    u32 i;

    CpuFill32(0, &gNetSync, sizeof(gNetSync));
    sReturningFromTalkLink = FALSE;
    for (i = 0; i < NETSYNC_MAGIC_LENGTH; i++)
    {
        gNetSync.magic[i] = sMagicXored[i] ^ MAGIC_XOR;
        gNetSyncIwramMarker[i] = sIwramMarkerXored[i] ^ MAGIC_XOR;
    }
    gNetSync.version = NETSYNC_VERSION;
}

bool8 NetLink_RingFull(const struct NetLinkRing *ring)
{
    return (u8)(ring->head - ring->tail) >= NETLINK_RING_SIZE;
}

bool8 NetLink_RingEmpty(const struct NetLinkRing *ring)
{
    return ring->head == ring->tail;
}

// Discards packets left over from a previous connection. (The outbox is
// drained by the host, which drops it whenever the link isn't established.)
void NetLink_DrainInbox(void)
{
    gNetSync.link.inbox.tail = gNetSync.link.inbox.head;
}

void NetSync_FrameTick(void)
{
    gNetSync.frameCounter++;
}

static bool8 IsOverworldSyncAllowed(void)
{
    if (gMain.callback1 != CB1_Overworld)
        return FALSE;
    // Not while the Quest Log replays earlier events ("Previously on your
    // quest..."). Recording new events is part of normal play.
    if (QL_GetPlaybackState() == QL_PLAYBACK_STATE_RUNNING || gQuestLogState == QL_STATE_PLAYBACK)
        return FALSE;
    if (InUnionRoom() || IsUpdateLinkStateCBActive())
        return FALSE;
    return TRUE;
}

static void PublishLocalPlayer(void)
{
    struct ObjectEvent *player = &gObjectEvents[gPlayerAvatar.objectEventId];
    struct NetSyncPlayer *local = &gNetSync.local;

    local->mapGroup = gSaveBlock1Ptr->location.mapGroup;
    local->mapNum = gSaveBlock1Ptr->location.mapNum;
    local->facing = player->facingDirection;
    local->x = player->currentCoords.x - MAP_OFFSET;
    local->y = player->currentCoords.y - MAP_OFFSET;
    local->elevation = player->currentElevation;
    local->avatarFlags = gPlayerAvatar.flags;
    local->gender = gSaveBlock2Ptr->playerGender;
    StringCopyN(local->name, gSaveBlock2Ptr->playerName, NETSYNC_NAME_LENGTH);
    local->active = TRUE;
}

static u8 FindNetObjectEvent(u8 localId)
{
    u8 i;

    for (i = 0; i < OBJECT_EVENTS_COUNT; i++)
    {
        if (gObjectEvents[i].active && gObjectEvents[i].localId == localId)
            return i;
    }
    return OBJECT_EVENTS_COUNT;
}

static u8 GetRemoteGraphicsId(const struct NetSyncPlayer *remote)
{
    u8 state;
    u8 gender = remote->gender != MALE ? FEMALE : MALE;

    if (remote->avatarFlags & (PLAYER_AVATAR_FLAG_MACH_BIKE | PLAYER_AVATAR_FLAG_ACRO_BIKE))
        state = PLAYER_AVATAR_GFX_BIKE;
    else if (remote->avatarFlags & PLAYER_AVATAR_FLAG_SURFING)
        state = PLAYER_AVATAR_GFX_RIDE;
    else
        state = PLAYER_AVATAR_GFX_NORMAL;
    return GetPlayerAvatarGraphicsIdByStateIdAndGender(state, gender);
}

static bool8 IsValidDirection(u8 direction)
{
    return direction >= DIR_SOUTH && direction <= DIR_EAST;
}

static bool8 IsRemoteVisible(const struct NetSyncPlayer *remote)
{
    struct ObjectEvent *player = &gObjectEvents[gPlayerAvatar.objectEventId];
    s16 dx, dy;

    if (!remote->active)
        return FALSE;
    if (remote->mapGroup != gSaveBlock1Ptr->location.mapGroup || remote->mapNum != gSaveBlock1Ptr->location.mapNum)
        return FALSE;

    dx = remote->x - (player->currentCoords.x - MAP_OFFSET);
    dy = remote->y - (player->currentCoords.y - MAP_OFFSET);
    if (dx < -SPAWN_RANGE_X || dx > SPAWN_RANGE_X || dy < -SPAWN_RANGE_Y || dy > SPAWN_RANGE_Y)
        return FALSE;
    return TRUE;
}

static u8 SpawnRemotePlayer(u8 localId, const struct NetSyncPlayer *remote)
{
    struct ObjectEventTemplate template;
    u8 objectEventId;

    template.localId = localId;
    template.graphicsId = GetRemoteGraphicsId(remote);
    template.kind = OBJ_KIND_NORMAL;
    template.x = remote->x;
    template.y = remote->y;
    template.objUnion.normal.elevation = remote->elevation;
    template.objUnion.normal.movementType = MOVEMENT_TYPE_NONE;
    template.objUnion.normal.movementRangeX = 0;
    template.objUnion.normal.movementRangeY = 0;
    template.objUnion.normal.trainerType = TRAINER_TYPE_NONE;
    template.objUnion.normal.trainerRange_berryTreeId = 0;
    template.script = NULL;
    template.flagId = 0;

    objectEventId = SpawnSpecialObjectEvent(&template);
    if (objectEventId != OBJECT_EVENTS_COUNT && IsValidDirection(remote->facing))
        ObjectEventTurn(&gObjectEvents[objectEventId], remote->facing);
    return objectEventId;
}

static u8 GetStepDirection(s16 dx, s16 dy)
{
    s16 absX = dx < 0 ? -dx : dx;
    s16 absY = dy < 0 ? -dy : dy;

    if (absX >= absY)
        return dx > 0 ? DIR_EAST : DIR_WEST;
    else
        return dy > 0 ? DIR_SOUTH : DIR_NORTH;
}

static u8 GetStepMovementAction(const struct NetSyncPlayer *remote, u8 direction, s16 distance)
{
    // 0 = walk, 1 = run, 2 = bike; falling behind bumps the speed up a level.
    u8 speed = 0;

    if (remote->avatarFlags & (PLAYER_AVATAR_FLAG_MACH_BIKE | PLAYER_AVATAR_FLAG_ACRO_BIKE))
        speed = 2;
    else if (remote->avatarFlags & (PLAYER_AVATAR_FLAG_DASH | PLAYER_AVATAR_FLAG_SURFING))
        speed = 1;
    if (distance > 1 && speed < 2)
        speed++;

    switch (speed)
    {
    case 0:
        return GetWalkNormalMovementAction(direction);
    case 1:
        return GetWalkFastMovementAction(direction);
    default:
        return GetWalkFasterMovementAction(direction);
    }
}

static void StepTowardsRemote(struct ObjectEvent *objectEvent, const struct NetSyncPlayer *remote)
{
    s16 dx, dy, distance;
    u8 direction;

    // Wait for the previous step or turn to finish.
    if (ObjectEventClearHeldMovementIfFinished(objectEvent) == 0)
        return;

    dx = remote->x - (objectEvent->currentCoords.x - MAP_OFFSET);
    dy = remote->y - (objectEvent->currentCoords.y - MAP_OFFSET);
    distance = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);

    if (distance == 0)
    {
        objectEvent->currentElevation = remote->elevation;
        objectEvent->previousElevation = remote->elevation;
        if (IsValidDirection(remote->facing) && objectEvent->facingDirection != remote->facing)
            ObjectEventSetHeldMovement(objectEvent, GetFaceDirectionMovementAction(remote->facing));
    }
    else if (distance > TELEPORT_DISTANCE)
    {
        MoveObjectEventToMapCoords(objectEvent, remote->x + MAP_OFFSET, remote->y + MAP_OFFSET);
        objectEvent->currentElevation = remote->elevation;
        objectEvent->previousElevation = remote->elevation;
        if (IsValidDirection(remote->facing))
            ObjectEventTurn(objectEvent, remote->facing);
    }
    else
    {
        direction = GetStepDirection(dx, dy);
        ObjectEventSetHeldMovement(objectEvent, GetStepMovementAction(remote, direction, distance));
    }
}

static void PublishScreenPos(u8 slot, u8 objectEventId)
{
    struct NetSyncScreenPos *pos = &gNetSync.screen[slot];
    struct Sprite *sprite;

    if (objectEventId == OBJECT_EVENTS_COUNT)
    {
        pos->visible = FALSE;
        return;
    }
    sprite = &gSprites[gObjectEvents[objectEventId].spriteId];
    // Same position calculation as the OAM update in sprite.c.
    pos->x = sprite->x + sprite->x2 + gSpriteCoordOffsetX;
    pos->y = sprite->y + sprite->y2 + sprite->centerToCornerVecY + gSpriteCoordOffsetY;
    pos->visible = !sprite->invisible;
}

static void UpdateRemotePlayer(u8 slot)
{
    const struct NetSyncPlayer *remote = &gNetSync.remote[slot];
    u8 localId = NETSYNC_LOCALID_BASE + slot;
    u8 objectEventId = FindNetObjectEvent(localId);
    bool8 visible = IsRemoteVisible(remote);
    struct ObjectEvent *objectEvent;

    if (objectEventId != OBJECT_EVENTS_COUNT)
    {
        objectEvent = &gObjectEvents[objectEventId];
        // Respawn when the avatar changes (bike/surf) or when the local player
        // crossed a map connection, since coordinates are relative to the map.
        if (!visible
         || objectEvent->graphicsId != GetRemoteGraphicsId(remote)
         || objectEvent->mapNum != gSaveBlock1Ptr->location.mapNum
         || objectEvent->mapGroup != gSaveBlock1Ptr->location.mapGroup)
        {
            RemoveObjectEvent(objectEvent);
            objectEventId = OBJECT_EVENTS_COUNT;
        }
    }

    if (visible)
    {
        if (objectEventId == OBJECT_EVENTS_COUNT)
            objectEventId = SpawnRemotePlayer(localId, remote);
        else
            StepTowardsRemote(&gObjectEvents[objectEventId], remote);
    }
    PublishScreenPos(slot, objectEventId);
}

// ---------------------------------------------------------------------------
// Talking to other players (scripts in data/netsync_scripts.s)

// The remote player object standing at map coordinates (x, y) (with
// MAP_OFFSET), or OBJECT_EVENTS_COUNT.
u8 NetSync_GetRemotePlayerObjectAt(s16 x, s16 y)
{
    u8 i;

    for (i = 0; i < OBJECT_EVENTS_COUNT; i++)
    {
        if (gObjectEvents[i].active && IS_NETSYNC_LOCALID(gObjectEvents[i].localId)
         && gObjectEvents[i].currentCoords.x == x && gObjectEvents[i].currentCoords.y == y)
            return i;
    }
    return OBJECT_EVENTS_COUNT;
}

const u8 *NetSync_GetRemotePlayerScript(void)
{
    return NetSync_EventScript_TalkToPlayer;
}

bool8 NetSync_ShouldAutoConfirmLink(void)
{
    return gNetSync.talk.gameState == NETTALK_GAME_ACCEPTED;
}

// gStringVar1 = the name of remote player `slot`. FALSE if nobody is there.
static bool8 BufferRemoteName(u8 slot)
{
    if (slot >= NETSYNC_MAX_REMOTE || !gNetSync.remote[slot].active)
        return FALSE;
    StringCopyN(gStringVar1, gNetSync.remote[slot].name, NETSYNC_NAME_LENGTH);
    gStringVar1[NETSYNC_NAME_LENGTH] = EOS;
    return TRUE;
}

// The player talked to a remote player (VAR_LAST_TALKED): gStringVar1 = their
// name, VAR_RESULT = FALSE if they are gone.
void NetSync_BufferTalkedPlayerName(void)
{
    gSpecialVar_Result = BufferRemoteName(gSpecialVar_LastTalked - NETSYNC_LOCALID_BASE);
}

// Invites the player talked to, to a trade or battle (VAR_0x8008 = NETTALK_KIND_*).
void NetSync_SendInvite(void)
{
    struct NetTalk *talk = &gNetSync.talk;

    talk->answer = NETTALK_ANSWER_NONE;
    talk->slot = gSpecialVar_LastTalked - NETSYNC_LOCALID_BASE;
    talk->kind = gSpecialVar_0x8008;
    talk->gameState = NETTALK_GAME_INVITING;
}

static void Task_WaitForAnswer(u8 taskId)
{
    struct NetTalk *talk = &gNetSync.talk;
    u8 answer = talk->answer;

    if (answer == NETTALK_ANSWER_NONE && JOY_NEW(B_BUTTON))
    {
        talk->gameState = NETTALK_GAME_IDLE; // the host tells the other player
    }
    else if (answer != NETTALK_ANSWER_NONE)
    {
        talk->gameState = answer == NETTALK_ANSWER_ACCEPTED ? NETTALK_GAME_ACCEPTED : NETTALK_GAME_IDLE;
    }
    else
    {
        return;
    }
    gSpecialVar_Result = answer; // NETTALK_ANSWER_NONE if canceled with B
    DestroyTask(taskId);
    ScriptContext_Enable();
}

// Waits (with waitstate) for the answer to NetSync_SendInvite.
void NetSync_WaitForAnswer(void)
{
    CreateTask(Task_WaitForAnswer, 80);
}

// For the invited player: gStringVar1 = who invites, gStringVar2 = "trade" or
// "battle", VAR_0x8008 = NETTALK_KIND_*.
void NetSync_BufferInvite(void)
{
    struct NetTalk *talk = &gNetSync.talk;

    BufferRemoteName(talk->slot);
    StringCopy(gStringVar2, talk->kind == NETTALK_KIND_BATTLE ? sText_Battle : sText_Trade);
    gSpecialVar_0x8008 = talk->kind;
}

// VAR_RESULT = FALSE if the inviting player canceled or left meanwhile.
void NetSync_CheckInviteOpen(void)
{
    gSpecialVar_Result = gNetSync.talk.answer != NETTALK_ANSWER_CANCELED
                      && gNetSync.remote[gNetSync.talk.slot].active;
}

void NetSync_AcceptInvite(void)
{
    gNetSync.talk.gameState = NETTALK_GAME_ACCEPTED;
}

void NetSync_DeclineInvite(void)
{
    gNetSync.talk.gameState = NETTALK_GAME_DECLINED;
}

// Called once the link is up (or failed); the link keeps its partner.
void NetSync_EndTalk(void)
{
    gNetSync.talk.gameState = NETTALK_GAME_IDLE;
}

// Makes leaving the Cable Club room bring the player back to this spot.
void NetSync_SetTalkLinkReturnWarp(void)
{
    struct ObjectEvent *player = &gObjectEvents[gPlayerAvatar.objectEventId];

    SetDynamicWarpWithCoords(0, gSaveBlock1Ptr->location.mapGroup, gSaveBlock1Ptr->location.mapNum, WARP_ID_NONE,
                             player->currentCoords.x - MAP_OFFSET, player->currentCoords.y - MAP_OFFSET);
    sReturningFromTalkLink = TRUE;
}

// Back from the Cable Club room: undo what the Cable Club receptionist's exit
// script would.
static void FinishTalkLink(void)
{
    sReturningFromTalkLink = FALSE;
    HelpSystem_Enable();
    QuestLog_StartRecordingInputsAfterDeferredEvent();
}

// Shows an invitation from another player once this player is free to answer.
static void TryShowInvite(void)
{
    struct NetTalk *talk = &gNetSync.talk;
    u8 slot = talk->inviteSlot;

    if (slot == 0 || slot > NETSYNC_MAX_REMOTE || !gNetSync.remote[slot - 1].active)
        return;
    if (talk->gameState != NETTALK_GAME_IDLE && talk->gameState != NETTALK_GAME_DECLINED)
        return;
    if (ScriptContext_IsEnabled() || ArePlayerFieldControlsLocked())
        return;

    talk->answer = NETTALK_ANSWER_NONE; // the host may now report a cancellation
    talk->slot = slot - 1;
    talk->kind = talk->inviteKind;
    talk->gameState = NETTALK_GAME_PROMPTING; // the host clears inviteSlot
    ScriptContext_SetupScript(NetSync_EventScript_Invited);
}

// Called every frame from the overworld main callback.
void NetSync_UpdateOverworld(void)
{
    u8 i;

    if (!IsOverworldSyncAllowed())
        return;

    // (The link stays up until the player has left the Cable Club room.)
    if (sReturningFromTalkLink && !gReceivedRemoteLinkPlayers)
        FinishTalkLink();

    PublishLocalPlayer();
    gNetSync.overworldFrame = gNetSync.frameCounter;

    for (i = 0; i < NETSYNC_MAX_REMOTE; i++)
        UpdateRemotePlayer(i);

    TryShowInvite();
}
