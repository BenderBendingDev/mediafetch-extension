import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env["PORT"] ?? 4173);
const toneWav = createToneWav(1);
const slowToneWav = createToneWav(20);
const syntheticWebmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const recordings = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/recordings/")) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    recordings.set(url.pathname, Buffer.concat(chunks));
    response.writeHead(204);
    response.end();
    return;
  }

  switch (url.pathname) {
    case "/health":
      send(response, "ok", "text/plain");
      return;
    case "/fixture":
      send(
        response,
        html(
          "Synthetic media fixture",
          '<audio controls title="Synthetic tone" src="/tone.wav" type="audio/wav"></audio>',
        ),
        "text/html",
      );
      return;
    case "/av-fixture":
      send(
        response,
        html(
          "Synthetic audio and video fixture",
          [
            '<audio controls title="Detected synthetic audio" src="/tone.wav" type="audio/wav"></audio>',
            '<video controls title="Detected synthetic video" src="/synthetic-video.webm" type="video/webm"></video>',
          ].join(""),
        ),
        "text/html",
      );
      return;
    case "/slow-fixture":
      send(
        response,
        html(
          "Slow media fixture",
          '<audio controls title="Slow synthetic tone" src="/slow.wav" type="audio/wav"></audio>',
        ),
        "text/html",
      );
      return;
    case "/encrypted-fixture":
      send(
        response,
        html(
          "Encrypted media fixture",
          '<a download href="/encrypted/master.m3u8">Encrypted synthetic stream</a>',
        ),
        "text/html",
      );
      return;
    case "/dash-fixture":
      send(
        response,
        html(
          "Synthetic DASH fixture",
          '<a download href="/dash/manifest.mpd">Synthetic DASH recording</a>',
        ),
        "text/html",
      );
      return;
    case "/tone.wav":
      send(response, toneWav, "audio/wav");
      return;
    case "/slow.wav":
      sendSlowly(request, response, slowToneWav, "audio/wav");
      return;
    case "/synthetic-video.webm":
      send(response, syntheticWebmHeader, "video/webm");
      return;
    case "/encrypted/master.m3u8":
      send(
        response,
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="local.key"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST',
        "application/vnd.apple.mpegurl",
      );
      return;
    case "/dash/manifest.mpd":
      if (
        !recordings.has("/recordings/video.webm") ||
        !recordings.has("/recordings/audio.webm")
      ) {
        response.writeHead(404);
        response.end("MediaRecorder fixtures have not been uploaded.");
        return;
      }
      send(response, dashManifest(), "application/dash+xml");
      return;
    case "/dash/video.webm":
      sendRecording(response, "/recordings/video.webm");
      return;
    case "/dash/audio.webm":
      sendRecording(response, "/recordings/audio.webm");
      return;
    default:
      response.writeHead(404);
      response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`fixture-server-ready http://${host}:${port}`);
});

function html(title, body) {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><main><h1>${title}</h1>${body}</main></body>
</html>`;
}

function send(response, body, contentType) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  response.writeHead(200, {
    "Content-Length": String(bytes.length),
    "Content-Type": contentType,
  });
  response.end(bytes);
}

function sendRecording(response, key) {
  const recording = recordings.get(key);
  if (recording === undefined) {
    response.writeHead(404);
    response.end("Recording not found");
    return;
  }
  send(response, recording, "video/webm");
}

function sendSlowly(request, response, body, contentType) {
  response.writeHead(200, {
    "Content-Length": String(body.length),
    "Content-Type": contentType,
  });
  let offset = 0;
  const timer = setInterval(() => {
    const next = Math.min(body.length, offset + 2_048);
    response.write(body.subarray(offset, next));
    offset = next;
    if (offset >= body.length) {
      clearInterval(timer);
      response.end();
    }
  }, 50);
  request.on("close", () => clearInterval(timer));
}

function createToneWav(seconds) {
  const sampleRate = 8_000;
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000,
    );
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

function dashManifest() {
  return `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/webm">
      <Representation id="video-main" bandwidth="200000" codecs="vp8">
        <SegmentList><SegmentURL media="video.webm"/></SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/webm">
      <Representation id="audio-main" bandwidth="64000" codecs="opus">
        <SegmentList><SegmentURL media="audio.webm"/></SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}
