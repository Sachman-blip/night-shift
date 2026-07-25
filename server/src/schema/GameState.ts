import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 1.05; // capsule center height
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("number") pitch = 0;
  @type("boolean") torch = true;
  @type("uint8") colorIndex = 0;
  @type("uint8") carrying = 0;
  @type("uint8") extractedCount = 0;
  /** Quota value banked by this player (items are worth 1-5 each). */
  @type("uint16") extractedValue = 0;
  @type("uint8") deaths = 0;
  @type("float32") stamina = 1;
  @type("boolean") crouching = false;
  /** How loud this player currently is; scales every monster's hearing. */
  @type("float32") noise = 0.25;
  /** Charge left in the loaded flashlight cell, 0..1. */
  @type("float32") battery = 1;
  /** Unused spare cells on this player's belt. */
  @type("uint8") cells = 0;
  /** On the floor, bleeding, waiting for a teammate. */
  @type("boolean") downed = false;
  /** Seconds of consciousness left while downed. */
  @type("float32") bleed = 0;
  /** 0..1 progress of the revive currently being worked on this player. */
  @type("float32") reviveProgress = 0;
}

export class Enemy extends Schema {
  @type("number") x = 0;
  @type("number") y = 1.05;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("string") aiState = "patrol";
  @type("string") variant = "stalker";
  /** Currently tearing at a shut door instead of moving. */
  @type("boolean") forcing = false;
}

export class Loot extends Schema {
  @type("string") kind = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  /** sessionId of the carrier, or "" when on the ground. */
  @type("string") carrier = "";
  @type("boolean") extracted = false;
}

export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Enemy }) enemies = new MapSchema<Enemy>();
  @type({ map: Loot }) loot = new MapSchema<Loot>();
  @type("string") phase = "active";
  @type("boolean") win = false;
  @type("uint16") timeLeft = 0;
  /** Quota is a VALUE target, not an item count. */
  @type("uint16") quota = 0;
  @type("uint16") extractedTotal = 0;
  /** 1-based; clearing a shift advances it, failing repeats it. */
  @type("uint16") shift = 1;
  // escape-room gates
  @type("boolean") keycardTaken = false;
  @type("boolean") archivesUnlocked = false;
  @type("boolean") shortcutOpen = false;
  /**
   * Open/closed bit per swinging door, index-aligned with the layout's
   * `doors` array (a fixed skeleton feature, so indices are stable).
   */
  @type(["boolean"]) doors = new ArraySchema<boolean>();
  /** Crew-wide spendable credit, carried between shifts. */
  @type("uint16") credits = 0;
  /** Purchased upgrade levels, keyed by UPGRADES id. */
  @type({ map: "uint8" }) upgrades = new MapSchema<number>();
  /** JSON LayoutDescriptor; clients expand it with the shared buildLayout(). */
  @type("string") layout = "";
}
