#include "global.h"
#include "event_object_movement.h"
#include "field_player_avatar.h"
#include "fieldmap.h"
#include "link.h"
#include "netsync.h"
#include "overworld.h"
#include "quest_log.h"
#include "string_util.h"
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

// "NARUTO-NETSYNC01" XORed with MAGIC_XOR. The real string is only ever
// assembled in RAM so that scanning emulator memory finds gNetSync and not
// a copy of this table in ROM.
static const u8 sMagicXored[NETSYNC_MAGIC_LENGTH] = {
    'N' ^ MAGIC_XOR, 'A' ^ MAGIC_XOR, 'R' ^ MAGIC_XOR, 'U' ^ MAGIC_XOR,
    'T' ^ MAGIC_XOR, 'O' ^ MAGIC_XOR, '-' ^ MAGIC_XOR, 'N' ^ MAGIC_XOR,
    'E' ^ MAGIC_XOR, 'T' ^ MAGIC_XOR, 'S' ^ MAGIC_XOR, 'Y' ^ MAGIC_XOR,
    'N' ^ MAGIC_XOR, 'C' ^ MAGIC_XOR, '0' ^ MAGIC_XOR, '1' ^ MAGIC_XOR,
};

void NetSync_Init(void)
{
    u32 i;

    CpuFill32(0, &gNetSync, sizeof(gNetSync));
    for (i = 0; i < NETSYNC_MAGIC_LENGTH; i++)
        gNetSync.magic[i] = sMagicXored[i] ^ MAGIC_XOR;
    gNetSync.version = NETSYNC_VERSION;
}

void NetSync_FrameTick(void)
{
    gNetSync.frameCounter++;
}

static bool8 IsOverworldSyncAllowed(void)
{
    if (gMain.callback1 != CB1_Overworld)
        return FALSE;
    if (QL_GetPlaybackState() != QL_PLAYBACK_STATE_STOPPED || gQuestLogState == QL_STATE_PLAYBACK)
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

// Called every frame from the overworld main callback.
void NetSync_UpdateOverworld(void)
{
    u8 i;

    if (!IsOverworldSyncAllowed())
        return;

    PublishLocalPlayer();
    gNetSync.overworldFrame = gNetSync.frameCounter;

    for (i = 0; i < NETSYNC_MAX_REMOTE; i++)
        UpdateRemotePlayer(i);
}
