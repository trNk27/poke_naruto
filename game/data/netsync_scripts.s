@ Talking to other players (see NetTalk in include/netsync.h and the talk
@ functions in src/netsync.c).
@
@ Talking to another player's character offers the Trade Center or the
@ Colosseum. The other player is asked; when both agree (and have saved),
@ both games open the link, are paired with each other and go straight into
@ the room. Leaving the room brings each player back to where they stood.
@
@ VAR_0x8008 holds the kind of link (NETTALK_KIND_*) throughout.

#include "constants/global.h"
#include "constants/vars.h"
#include "constants/maps.h"
#include "constants/menu.h"
#include "constants/cable_club.h"
#include "constants/event_objects.h"
	.include "asm/macros.inc"
	.include "asm/macros/event.inc"
	.set FALSE, 0
	.set TRUE,  1

	@ NETTALK_KIND_* and NETTALK_ANSWER_* in include/netsync.h
	.set KIND_TRADE,  1
	.set KIND_BATTLE, 2
	.set ANSWER_NONE,     0
	.set ANSWER_ACCEPTED, 1
	.set ANSWER_DECLINED, 2
	.set ANSWER_BUSY,     3
	.set ANSWER_CANCELED, 4

	.section .rodata

NetSync_EventScript_TalkToPlayer::
	lock
	callnative NetSync_BufferTalkedPlayerName
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_Release
	message NetSync_Text_WhatToDo
	waitmessage
	multichoice 0, 0, MULTICHOICE_TRADE_CENTER_COLOSSEUM, FALSE
	switch VAR_RESULT
	case 0, NetSync_EventScript_ChoseTrade
	case 1, NetSync_EventScript_ChoseBattle
	goto NetSync_EventScript_CloseAndRelease
	end

NetSync_EventScript_ChoseTrade::
	setvar VAR_0x8008, KIND_TRADE
	call CableClub_EventScript_CheckPartyTradeRequirements
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_Release
	goto NetSync_EventScript_Invite
	end

NetSync_EventScript_ChoseBattle::
	setvar VAR_0x8008, KIND_BATTLE
	goto NetSync_EventScript_Invite
	end

NetSync_EventScript_Invite::
	call EventScript_AskSaveGame
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_CloseAndRelease
	callnative NetSync_BufferTalkedPlayerName
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_CloseAndRelease
	callnative NetSync_SendInvite
	message NetSync_Text_WaitingForAnswer
	waitmessage
	callnative NetSync_WaitForAnswer
	waitstate
	switch VAR_RESULT
	case ANSWER_ACCEPTED, NetSync_EventScript_Linkup
	case ANSWER_DECLINED, NetSync_EventScript_Declined
	case ANSWER_BUSY, NetSync_EventScript_Busy
	case ANSWER_CANCELED, NetSync_EventScript_Gone
	goto NetSync_EventScript_CloseAndRelease
	end

NetSync_EventScript_Declined::
	msgbox NetSync_Text_Declined
	goto NetSync_EventScript_Release
	end

NetSync_EventScript_Busy::
	msgbox NetSync_Text_Busy
	goto NetSync_EventScript_Release
	end

NetSync_EventScript_Gone::
	msgbox NetSync_Text_Gone
	goto NetSync_EventScript_Release
	end

@ Another player's invitation, started by NetSync_UpdateOverworld.
NetSync_EventScript_Invited::
	lockall
	callnative NetSync_BufferInvite
	msgbox NetSync_Text_WouldYouLike, MSGBOX_YESNO
	goto_if_eq VAR_RESULT, NO, NetSync_EventScript_DeclineInvite
	callnative NetSync_CheckInviteOpen
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_InviteWithdrawn
	goto_if_eq VAR_0x8008, KIND_BATTLE, NetSync_EventScript_SaveAndAccept
	call CableClub_EventScript_CheckPartyTradeRequirements
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_DeclineInvite
NetSync_EventScript_SaveAndAccept::
	call EventScript_AskSaveGame
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_DeclineInvite
	callnative NetSync_CheckInviteOpen
	goto_if_eq VAR_RESULT, FALSE, NetSync_EventScript_InviteWithdrawn
	callnative NetSync_AcceptInvite
	goto NetSync_EventScript_Linkup
	end

NetSync_EventScript_DeclineInvite::
	callnative NetSync_DeclineInvite
	goto NetSync_EventScript_CloseAndRelease
	end

NetSync_EventScript_InviteWithdrawn::
	callnative NetSync_EndTalk
	callnative NetSync_BufferInvite
	msgbox NetSync_Text_Withdrawn
	goto NetSync_EventScript_Release
	end

@ Both players agreed: open the link (the host pairs the two) and go in.
NetSync_EventScript_Linkup::
	message CableClub_Text_PleaseWaitBCancel
	waitmessage
	callnative HelpSystem_Disable
	textcolor NPC_TEXT_COLOR_NEUTRAL
	goto_if_eq VAR_0x8008, KIND_BATTLE, NetSync_EventScript_LinkupBattle
	callnative TryTradeLinkup
	waitstate
	goto NetSync_EventScript_LinkupDone
	end

NetSync_EventScript_LinkupBattle::
	setvar VAR_0x8004, USING_SINGLE_BATTLE
	callnative TryBattleLinkup
	waitstate
NetSync_EventScript_LinkupDone::
	call EventScript_RestorePrevTextColor
	callnative NetSync_EndTalk
	goto_if_eq VAR_RESULT, LINKUP_SUCCESS, NetSync_EventScript_EnterRoom
	goto_if_eq VAR_RESULT, LINKUP_CONNECTION_ERROR, CableClub_EventScript_AbortLinkConnectionError
	goto_if_eq VAR_RESULT, LINKUP_PLAYER_NOT_READY, CableClub_EventScript_AbortLinkPlayerNotReady
	goto_if_eq VAR_RESULT, LINKUP_PARTNER_NOT_READY, CableClub_EventScript_AbortLinkOtherTrainerNotReady
	callnative CloseLink
	callnative HelpSystem_Enable
	msgbox NetSync_Text_LinkCanceled
	goto NetSync_EventScript_Release
	end

NetSync_EventScript_EnterRoom::
	setvar VAR_0x8007, 0 @ no receptionist to turn around afterwards
	callnative NetSync_SetTalkLinkReturnWarp
	goto_if_eq VAR_0x8008, KIND_BATTLE, NetSync_EventScript_EnterColosseum
	setvar VAR_0x8004, USING_TRADE_CENTER
	messageautoscroll CableClub_Text_PleaseEnter
	waitmessage
	delay 30
	closemessage
	release
	setwarp MAP_TRADE_CENTER, 5, 8
	callnative DoCableClubWarp
	waitstate
	end

NetSync_EventScript_EnterColosseum::
	callnative HealPlayerParty
	callnative SavePlayerParty
	callnative LoadPlayerBag
	messageautoscroll CableClub_Text_PleaseEnter
	waitmessage
	delay 30
	closemessage
	release
	warp MAP_BATTLE_COLOSSEUM_2P, 6, 8
	callnative DoCableClubWarp
	waitstate
	end

NetSync_EventScript_CloseAndRelease::
	closemessage
NetSync_EventScript_Release::
	release
	end

NetSync_Text_WhatToDo::
	.string "What would you like to do\n"
	.string "with {STR_VAR_1}?$"

NetSync_Text_WaitingForAnswer::
	.string "Waiting for {STR_VAR_1}…\n"
	.string "B Button: Cancel$"

NetSync_Text_Declined::
	.string "{STR_VAR_1} said no.$"

NetSync_Text_Busy::
	.string "{STR_VAR_1} is busy right now.\n"
	.string "Please try again later.$"

NetSync_Text_Gone::
	.string "{STR_VAR_1} is no longer here.$"

NetSync_Text_WouldYouLike::
	.string "{STR_VAR_1} would like to\n"
	.string "{STR_VAR_2} with you. Is that okay?$"

NetSync_Text_Withdrawn::
	.string "{STR_VAR_1} canceled.$"

NetSync_Text_LinkCanceled::
	.string "The link was canceled.$"
