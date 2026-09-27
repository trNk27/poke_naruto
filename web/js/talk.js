// Carries invitations between players who talk to each other in the game to
// trade or battle (see NetTalk in game/include/netsync.h and
// game/data/netsync_scripts.s).
//
//   inviter's game          server           invited player's game
//   INVITING  ── invite ──────────────────▶  shown once they are free
//             ◀── accept / decline / busy ──  (after they saved)
//   (B Button) ── cancel ──────────────────▶
//
// Once both agree, each side reserves the other in the LinkManager, so the
// two games are paired when they open the link.

import { LinkGameState, TalkAnswer, TalkGameState } from './netsync.js';

// How long an invitation may wait for the invited player to be free to answer
// (they may be in a menu or a battle) before the inviter is told they're busy.
const INVITE_TIMEOUT_MS = 8000;

export class TalkManager {
  constructor(bridge, net, peers, link) {
    this.bridge = bridge;
    this.net = net;
    this.peers = peers; // Map id -> { slot, ... }
    this.link = link;
    this.lastState = TalkGameState.IDLE;
    this.outgoing = null; // { peer } while our game waits for an answer
    this.incoming = null; // { peer, since, shown } while an invitation is pending
    net.addEventListener('talk', (e) => this.onMessage(e.detail));
  }

  peerInSlot(slot) {
    for (const [id, peer] of this.peers) if (peer.slot === slot) return id;
    return null;
  }

  onMessage({ from, op, kind }) {
    const bridge = this.bridge;
    if (!bridge.attached) {
      if (op === 'invite') this.net.sendTalk(from, 'busy');
      return;
    }
    switch (op) {
      case 'invite': {
        const peer = this.peers.get(from);
        const { gameState } = bridge.readTalk();
        const free = (gameState === TalkGameState.IDLE || gameState === TalkGameState.DECLINED)
          && !this.incoming && bridge.linkGameState === LinkGameState.CLOSED;
        if (!peer || !free || (kind !== 1 && kind !== 2)) {
          this.net.sendTalk(from, 'busy');
          return;
        }
        this.incoming = { peer: from, since: performance.now(), shown: false };
        bridge.setInvite(peer.slot, kind);
        break;
      }
      case 'cancel':
        if (this.incoming?.peer === from) this.withdrawIncoming();
        break;
      case 'accept':
      case 'decline':
      case 'busy':
        if (this.outgoing?.peer !== from) {
          if (op === 'accept') this.net.sendTalk(from, 'cancel'); // we gave up meanwhile
          return;
        }
        this.outgoing = null;
        if (op === 'accept') this.link.reservedPartner = from;
        bridge.setTalkAnswer(op === 'accept' ? TalkAnswer.ACCEPTED : op === 'decline' ? TalkAnswer.DECLINED : TalkAnswer.BUSY);
        break;
      default:
        break;
    }
  }

  withdrawIncoming() {
    if (this.incoming.shown) this.bridge.setTalkAnswer(TalkAnswer.CANCELED);
    else this.bridge.setInvite(-1);
    this.incoming = null;
  }

  /** Called every few milliseconds while the game runs. */
  tick(now) {
    const bridge = this.bridge;
    const { gameState, slot } = bridge.readTalk();
    const last = this.lastState;
    this.lastState = gameState;

    // Our game invites someone, or stops waiting for their answer.
    if (gameState === TalkGameState.INVITING && last !== TalkGameState.INVITING) {
      const peer = this.peerInSlot(slot);
      if (peer === null) {
        bridge.setTalkAnswer(TalkAnswer.CANCELED);
      } else {
        this.outgoing = { peer };
        this.net.sendTalk(peer, 'invite', bridge.readTalk().kind);
      }
    } else if (this.outgoing && gameState !== TalkGameState.INVITING) {
      this.net.sendTalk(this.outgoing.peer, 'cancel');
      this.outgoing = null;
    }
    if (this.outgoing && !this.peers.has(this.outgoing.peer)) {
      this.outgoing = null;
      bridge.setTalkAnswer(TalkAnswer.CANCELED);
    }

    // Someone invites us.
    const incoming = this.incoming;
    if (incoming) {
      if (!this.peers.has(incoming.peer)) {
        this.withdrawIncoming();
      } else if (!incoming.shown) {
        if (gameState === TalkGameState.PROMPTING) {
          incoming.shown = true;
          bridge.setInvite(-1);
        } else if (now - incoming.since > INVITE_TIMEOUT_MS) {
          bridge.setInvite(-1);
          this.net.sendTalk(incoming.peer, 'busy');
          this.incoming = null;
        }
      } else if (gameState === TalkGameState.ACCEPTED) {
        this.link.reservedPartner = incoming.peer;
        this.net.sendTalk(incoming.peer, 'accept');
        this.incoming = null;
      } else if (gameState !== TalkGameState.PROMPTING) {
        this.net.sendTalk(incoming.peer, 'decline');
        this.incoming = null;
      }
    }

    // The reservation lasts until the link is up (it then keeps its partner)
    // or has failed; either way the game goes back to IDLE.
    if (last === TalkGameState.ACCEPTED && gameState !== TalkGameState.ACCEPTED) this.link.reservedPartner = null;
  }
}
