/**
 * TwiML returned to Twilio when a call comes in. `<Connect><Stream>` opens a
 * bidirectional Media Streams WebSocket to our server for the life of the call;
 * `<Connect>` (vs `<Start>`) means the call stays in this stream until we hang up.
 *
 * https://www.twilio.com/docs/voice/twiml/stream
 */
export function connectStreamTwiml(wssUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wssUrl}" />
  </Connect>
</Response>`;
}
