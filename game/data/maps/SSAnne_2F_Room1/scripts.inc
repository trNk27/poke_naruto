SSAnne_2F_Room1_MapScripts::
	.byte 0

SSAnne_2F_Room1_EventScript_Gentleman::
	lock
	faceplayer
	message SSAnne_2F_Room1_Text_SleepingMonLookedLikeThis
	waitmessage
	setvar VAR_0x8004, SPECIES_NJ_JIRAIYA
	special SetSeenMon
	showmonpic SPECIES_NJ_JIRAIYA, 10, 3
	waitbuttonpress
	hidemonpic
	release
	end
