// proto-decoder.js — FCB Bot v5
// Loads MarketDataFeed.proto from localhost and exposes
// window.FCBProto.decode(arrayBuffer) → plain JS object
// Uses protobufjs v7 full build from cdnjs (no npm needed)

window.FCBProto = {
  _FeedResponse: null,

  async init() {
    // protobufjs already loaded by index.html <script> tag — skip re-injection
    if (typeof protobuf === "undefined") {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/protobufjs/7.2.5/protobuf.min.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("protobufjs CDN failed to load"));
        document.head.appendChild(s);
      });
    }

    // Fetch .proto file served by bridge.js from localhost
    const res = await fetch("/MarketDataFeed.proto");
    if (!res.ok) throw new Error("Failed to fetch MarketDataFeed.proto from bridge");
    const protoText = await res.text();

    // Parse proto from string (full build supports this)
    const root = protobuf.parse(protoText, { keepCase: true }).root;
    this._FeedResponse = root.lookupType(
      "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse"
    );
    console.log("✅ FCBProto: Protobuf decoder ready"); 
    window._fcbProtoReady = true;
  },

  decode(arrayBuffer) {
    if (!this._FeedResponse) throw new Error("FCBProto not initialised — call init() first");
    const bytes = new Uint8Array(arrayBuffer);
    const msg   = this._FeedResponse.decode(bytes);
    return this._FeedResponse.toObject(msg, {
      longs:   Number,   // convert int64 → JS number (safe for prices/timestamps)
      enums:   String,   // convert enum ints → string names
      defaults: true,
    });
  }
};
