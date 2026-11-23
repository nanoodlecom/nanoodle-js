/** Which node types contribute user inputs, and with what fields (mirrors play.html INPUT_SPECS). */
export const INPUT_SPECS = {
  text:    [{ f: "text",   label: "Text",  kind: "textarea" }],
  upload:  [{ f: "image",  label: "Image", kind: "image" }],
  aupload: [{ f: "audio",  label: "Audio", kind: "audio" }],
  vupload: [{ f: "video",  label: "Video", kind: "video" }],
  mupload: [{ f: "model",  label: "3D file", kind: "model3d" }],
  llm:     [{ f: "prompt", label: "Prompt", kind: "textarea" },
            { f: "system", label: "System prompt", kind: "textarea", optional: true, def: "You are a helpful, concise assistant." }],
  image:   [{ f: "prompt", label: "Image prompt", kind: "textarea" }],
  tvideo:  [{ f: "prompt", label: "Video prompt", kind: "textarea" }],
  music:   [{ f: "prompt", label: "Style / prompt", kind: "textarea" }],
  remix:   [{ f: "prompt", label: "Style / direction", kind: "textarea" }],
  tts:     [{ f: "prompt", label: "Text to speak", kind: "textarea" }],
  // Optional: image-only 3D models run with a photo and no prompt.
  model3d: [{ f: "prompt", label: "3D prompt", kind: "textarea", optional: true }],
  endpoint:[{ f: "prompt", label: "Prompt", kind: "textarea" }],
};

// Option lists verbatim from play.html (SIZES line 897, DURATIONS line 3232).
const SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const DURATIONS = ["5", "10"];

/** Per-node knobs that are not part of the IO shape (mirrors play.html SETTING_SPECS). */
export const SETTING_SPECS = {
  llm: [
    { f: "model", label: "Model", kind: "model" },
    { f: "temperature", label: "Temperature", kind: "number", def: "0.8" },
    { f: "maxTokens", label: "Max tokens", kind: "number" },
    { f: "format", label: "Output format", kind: "select", options: ["Text", "JSON"], def: "Text" },
    { f: "reasoningEffort", label: "Reasoning effort", kind: "select", options: ["default", "low", "medium", "high"], def: "default" },
    { f: "showThinking", label: "Show thinking", kind: "boolean" },
  ],
  vision: [
    { f: "model", label: "Model", kind: "model" },
    { f: "q", label: "Question", kind: "textarea", def: "Describe this image." },
  ],
  decide: [
    { f: "model", label: "Model", kind: "model" },
    { f: "mode", label: "Decide", kind: "select", options: ["pick", "choose", "score", "yesno"], def: "pick" },
    { f: "question", label: "Question", kind: "textarea" },
    { f: "options", label: "Labels (one per line)", kind: "textarea" },
    { f: "levels", label: "Scale (worst → best, one per line)", kind: "textarea", def: "poor\nokay\ngood\ngreat" },
    { f: "gate", label: "Gate: stop downstream on no", kind: "boolean" },
  ],
  image: [
    { f: "model", label: "Model", kind: "model" },
    { f: "size", label: "Image size", kind: "select", options: SIZES, def: "1024x1024" },
    { f: "variations", label: "Variations", kind: "number", def: "1" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  edit: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Edit instruction", kind: "textarea" },
    { f: "size", label: "Image size", kind: "select", options: SIZES, def: "1024x1024" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  tvideo: [
    { f: "model", label: "Model", kind: "model" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
    { f: "aspect", label: "Aspect ratio", kind: "select", options: ["16:9", "9:16", "1:1", "4:3", "3:4"], def: "16:9" },
    { f: "duration", label: "Duration", kind: "select", options: DURATIONS, def: "5" },
  ],
  ivideo: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Motion prompt", kind: "textarea" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
    { f: "aspect", label: "Aspect ratio", kind: "select", options: ["16:9", "9:16", "1:1", "4:3", "3:4"], def: "16:9" },
    { f: "duration", label: "Duration", kind: "select", options: DURATIONS, def: "5" },
  ],
  vedit: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Edit instruction", kind: "textarea" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
  ],
  lipsync: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Guidance prompt", kind: "textarea" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
  ],
  music: [
    { f: "model", label: "Model", kind: "model" },
    { f: "lyrics", label: "Lyrics", kind: "textarea" },
    { f: "instrumental", label: "Instrumental", kind: "boolean" },
    { f: "duration", label: "Duration (s)", kind: "number" },
    { f: "negative_prompt", label: "Negative prompt", kind: "textarea" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  remix: [
    { f: "model", label: "Model", kind: "model" },
    { f: "lyrics", label: "Lyrics", kind: "textarea" },
    { f: "duration", label: "Duration (s)", kind: "number" },
  ],
  tts: [
    { f: "model", label: "Model", kind: "model" },
    { f: "voice", label: "Voice", kind: "text" },
    { f: "speed", label: "Speed", kind: "number", def: "1" },
    { f: "instructions", label: "Voice instructions", kind: "textarea" },
  ],
  transcribe: [
    { f: "model", label: "Model", kind: "model" },
    { f: "language", label: "Language", kind: "text", def: "auto" },
  ],
  cleanvoice: [
    { f: "model", label: "Model", kind: "model" },
    { f: "url", label: "Public link (when nothing is wired)", kind: "text" },
  ],
  model3d: [
    { f: "model", label: "Model", kind: "model" },
  ],
  endpoint: [
    { f: "url", label: "URL", kind: "text", def: "http://127.0.0.1:8787/v1/chat/completions" },
    { f: "mode", label: "Mode", kind: "select", options: ["chat", "image", "video", "audio", "json"], def: "chat" },
    { f: "model", label: "Model", kind: "text", def: "local" },
    { f: "auth", label: "Authorization (optional)", kind: "text", def: "" },
  ],
  join: [{ f: "sep", label: "Separator (use \\n for a line break)", kind: "text", def: " " }],
  inpaint: [
    { f: "model", label: "Model", kind: "model" },
    { f: "size", label: "Image size", kind: "select", options: SIZES, def: "1024x1024" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  // local media knobs (play.html SETTING_SPECS) — shape-affecting fields for vframes/combine
  "slice-3d": [
    { f: "preset", label: "Preset", kind: "select", options: ["default", "character"], def: "default" },
    { f: "clip", label: "Animation clip", kind: "text", def: "" },
    { f: "frames", label: "Pose frames", kind: "number", min: 1, max: 64, def: "1" },
    { f: "slices", label: "Slices", kind: "number", min: 8, max: 128, def: "48" },
    { f: "resolution", label: "Tile resolution", kind: "number", min: 16, max: 128, def: "48" },
    { f: "palette", label: "Palette colors", kind: "number", min: 0, max: 64, def: "16" },
    { f: "outline", label: "Outline", kind: "boolean", def: true },
    { f: "upAxis", label: "Up axis", kind: "select", options: ["auto", "x", "y", "z"], def: "auto" },
  ],
  "sprite-stack-render": [
    { f: "yaw", label: "Yaw (degrees)", kind: "number", def: "35" },
    { f: "pitch", label: "Pitch (degrees)", kind: "number", min: 0, max: 90, def: "30" },
    { f: "spacing", label: "Layer spacing", kind: "number", min: 0, max: 4, def: "1" },
    { f: "scale", label: "Pixel scale", kind: "number", min: 1, max: 8, def: "3" },
    { f: "turntable", label: "Record turntable", kind: "boolean", def: false },
    { f: "duration", label: "Duration (s)", kind: "number", min: 0.25, max: 30, def: "3" },
    { f: "fps", label: "Frames per second", kind: "number", min: 1, max: 60, def: "24" },
    { f: "yawStart", label: "Start yaw", kind: "number", def: "0" },
    { f: "yawEnd", label: "End yaw", kind: "number", def: "360" },
  ],
  resize: [
    { f: "mode", label: "Mode", kind: "select", options: ["fit", "fill", "exact"], def: "fit" },
    { f: "width", label: "Width", kind: "number" },
    { f: "height", label: "Height", kind: "number" },
  ],
  vframes: [
    { f: "dir", label: "Start from", kind: "select", options: ["end", "start"], def: "end" },
    { f: "frames", label: "Frames", kind: "number", def: "1", min: 1, max: 48 },
    { f: "gap", label: "Gap (s)", kind: "number", def: "0.5" },
    { f: "stride", label: "Stride (every Nth frame)", kind: "number", def: "1", min: 1 },
    { f: "startSec", label: "Range start (s)", kind: "number" },
    { f: "endSec", label: "Range end (s)", kind: "number" },
  ],
  render3d: [
    { f: "mode", label: "Output", kind: "select", options: ["image", "video"], def: "image" },
    { f: "azimuth", label: "Azimuth (deg)", kind: "number", def: "35" },
    { f: "elevation", label: "Elevation (deg)", kind: "number", def: "18" },
    { f: "distance", label: "Distance (× size)", kind: "number", def: "1.9" },
    { f: "width", label: "Width", kind: "number", def: "800" },
    { f: "height", label: "Height", kind: "number", def: "600" },
    { f: "background", label: "Background", kind: "select", options: ["dark", "light", "transparent"], def: "dark" },
    { f: "clipAxis", label: "Slice axis", kind: "select", options: ["none", "x", "y", "z"], def: "none" },
    { f: "clipPos", label: "Slice position (-1..1)", kind: "number", def: "0" },
    { f: "clipSweep", label: "Video: sweep the slice", kind: "boolean" },
    { f: "explode", label: "Explode parts (0..1)", kind: "number", def: "0" },
    { f: "isolate", label: "Isolate part (index, name, or largest)", kind: "text" },
    { f: "animClip", label: "Animation clip (name or index)", kind: "text" },
    { f: "animTime", label: "Animation time (s)", kind: "number", def: "0" },
    { f: "turntable", label: "Video: turntable (deg)", kind: "number", def: "360" },
    { f: "duration", label: "Video: duration (s)", kind: "number", def: "2" },
    { f: "fps", label: "Video: fps", kind: "number", def: "24" },
  ],
  combine: [
    { f: "dedup", label: "Trim duplicate seam frame", kind: "boolean", def: true },
  ],
  soundtrack: [
    { f: "loop", label: "Loop audio to fill video", kind: "boolean", def: false },
  ],
  trim: [
    { f: "start", label: "Start (s)", kind: "number", def: "0" },
    { f: "length", label: "Length (s)", kind: "number", def: "30" },
  ],
  extractaudio: [
    { f: "start", label: "Start (s)", kind: "number", def: "0" },
    { f: "length", label: "Length (s)", kind: "number" },
  ],
};
