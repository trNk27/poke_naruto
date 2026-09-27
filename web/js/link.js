// Pairs this game's virtual link cable with another player's and relays the
// link traffic between them (see NetLink in game/src/link.c).
//
// Two players are linked when both open the link at the same time, e.g. by
// talking to the Cable Club receptionist in a Pokémon Center. With more
// players waiting at once, they are paired in order of joining the room.
// Players who agreed to link by talking to each other (talk.js) are
// reserved for each other and only paired together.

import { LinkGameState, LinkHostState } from './netsync.js';

export class LinkManager extends EventTarget {
  constructor(bridge, net, peers) {
    super();
    this.bridge = bridge;
    this.net = net;
    this.peers = peers; // Map id -> { name, state, linkState }
    this.partnerId = null;
    this.partnerWasEstablished = false;
    this.incoming = []; // packets from the partner not yet given to the game
    this.gameState = LinkGameState.CLOSED;
    this.hostState = null;
    this.isMaster = false;
    this.reservedPartner = null; // set by TalkManager
    this.trace = null; // set to an array to record link traffic (debugging)

    net.addEventListener('link', (e) => {
      const { from, p, g } = e.detail;
      const peer = this.peers.get(from);
      if (peer) peer.linkState = g;
      if (from !== this.partnerId || this.gameState === LinkGameState.CLOSED) return;
      for (const packet of p) this.incoming.push(packet);
    });
  }

  linkStateOf(id) {
    return this.peers.get(id)?.linkState ?? LinkGameState.CLOSED;
  }

  choosePartner() {
    if (this.reservedPartner !== null) return this.peers.has(this.reservedPartner) ? this.reservedPartner : null;
    const me = this.net.id;
    const waiting = [me];
    for (const [id, peer] of this.peers) {
      if (peer.state?.pair) continue; // reserved for someone
      if ((peer.linkState ?? 0) >= LinkGameState.SEARCHING) waiting.push(id);
    }
    waiting.sort((a, b) => a - b);
    const index = waiting.indexOf(me);
    return waiting[index ^ 1] ?? null;
  }

  setPartner(id) {
    if (id === this.partnerId) return;
    this.partnerId = id;
    this.partnerWasEstablished = false;
    this.incoming = [];
    if (id !== null) {
      this.dispatchEvent(new CustomEvent('paired', { detail: { name: this.peers.get(id)?.name ?? 'Trainer' } }));
    }
  }

  /** Called every few milliseconds while the game runs. */
  tick() {
    const bridge = this.bridge;
    const gameState = bridge.linkGameState;
    const previous = this.gameState;
    this.gameState = gameState;
    if (gameState !== previous) this.dispatchEvent(new CustomEvent('statechange', { detail: gameState }));

    if (gameState === LinkGameState.CLOSED || !this.net.connected) {
      this.setPartner(null);
      bridge.takeOutbox(); // nothing to send without a connection
      this.writeHostState(LinkHostState.NO_PARTNER, false);
      return;
    }

    // Keep the partner once connected; until then, re-pair as players come and go.
    const partnerPresent = this.partnerId !== null && this.peers.has(this.partnerId);
    if (gameState !== LinkGameState.ESTABLISHED || !partnerPresent) {
      if (!partnerPresent || this.linkStateOf(this.partnerId) === LinkGameState.CLOSED) {
        if (gameState !== LinkGameState.ESTABLISHED) this.setPartner(this.choosePartner());
      }
    }

    const partner = this.partnerId;
    const partnerState = partner !== null && this.peers.has(partner) ? this.linkStateOf(partner) : null;
    if (partnerState === LinkGameState.ESTABLISHED) this.partnerWasEstablished = true;

    let hostState;
    if (partnerState === null) {
      hostState = gameState === LinkGameState.ESTABLISHED ? LinkHostState.PARTNER_LOST : LinkHostState.NO_PARTNER;
    } else if (gameState === LinkGameState.ESTABLISHED
      && (partnerState === LinkGameState.CLOSED || (this.partnerWasEstablished && partnerState !== LinkGameState.ESTABLISHED))) {
      hostState = LinkHostState.PARTNER_LOST;
    } else if (partnerState === LinkGameState.ESTABLISHED) {
      hostState = LinkHostState.PARTNER_ESTABLISHED;
    } else if (partnerState === LinkGameState.SEARCHING) {
      hostState = LinkHostState.PARTNER_SEARCHING;
    } else {
      hostState = LinkHostState.NO_PARTNER;
    }
    // Hold back "lost" until everything the partner sent has been delivered.
    if (hostState === LinkHostState.PARTNER_LOST && this.incoming.length) hostState = LinkHostState.PARTNER_ESTABLISHED;
    this.writeHostState(hostState, partner !== null && this.net.id < partner);

    if (gameState === LinkGameState.ESTABLISHED) {
      if (this.incoming.length) {
        const delivered = bridge.fillInbox(this.incoming);
        this.incoming.splice(0, delivered);
      }
      const outgoing = bridge.takeOutbox();
      if (outgoing.length && partner !== null) this.net.sendLink(partner, outgoing, gameState);
      if (this.trace) {
        // The master's packets are complete transfer entries; the slave's are
        // only its own commands, so record the master's entries it receives.
        const t = Math.round(performance.now());
        if (this.isMaster) for (const p of outgoing) this.trace.push([t, 'tick', ...p]);
        else for (const p of outgoing) this.trace.push([t, 'send', ...p.slice(0, 8)]);
      }
    } else {
      bridge.takeOutbox();
    }
  }

  writeHostState(state, isMaster) {
    // Written every tick: a soft reset of the game clears it.
    this.hostState = state;
    this.isMaster = isMaster;
    this.bridge.setLinkHostState(state, isMaster);
  }
}
