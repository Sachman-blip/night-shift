import { Schema, MapSchema, type } from "@colyseus/schema";

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
  @type("uint8") deaths = 0;
  @type("float32") stamina = 1;
}

export class Enemy extends Schema {
  @type("number") x = 0;
  @type("number") y = 1.05;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("string") aiState = "patrol";
  @type("string") variant = "stalker";
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
  @type("uint8") quota = 0;
  @type("uint8") extractedTotal = 0;
  /** 1-based; clearing a shift advances it, failing repeats it. */
  @type("uint16") shift = 1;
  // escape-room gates
  @type("boolean") keycardTaken = false;
  @type("boolean") archivesUnlocked = false;
  @type("boolean") shortcutOpen = false;
  /** JSON LayoutDescriptor; clients expand it with the shared buildLayout(). */
  @type("string") layout = "";
}
