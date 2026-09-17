import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// Minimal structural cuts from a read-only copy of native session ef9f6907-d788-40bd-a8f8-2f1de1f53040.
// Unrelated private content and model signatures are replaced while native command records and lineage remain intact.
export const toSpecPrompt = "/to-spec 就这样先实现一个版本吧，以后再调整。";
export const modelTypedPrompt = "pi-hermes-memory是什么，设计思想、社区评价如何";
export const copyTypedPrompt = "GPT:拆分方向同意，但有两处不能直接照建议落地。";

export const toSpecRecords: CcNativeRecord[] = [
  { uuid: "fixture-root", parentUuid: null, type: "user", timestamp: "2026-09-06T17:32:22.000Z", promptSource: "sdk",
    message: { role: "user", content: "fixture root" } },
  { uuid: "ad9dd570-96fc-439c-b695-d2f7ffa931f3", parentUuid: "fixture-root", type: "assistant", timestamp: "2026-09-06T17:32:23.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "fixture reply" }] } },
  { uuid: "76daf7a6-7627-43f9-8d70-022fe70111ad", parentUuid: "ad9dd570-96fc-439c-b695-d2f7ffa931f3", type: "user",
    timestamp: "2026-09-06T17:32:24.308Z", promptId: "64174e43-de5b-4fa9-9d8c-41f8f18f14fc", userType: "external", origin: { kind: "human" },
    message: { role: "user", content: "<command-message>to-spec</command-message>\n<command-name>/to-spec</command-name>\n<command-args>就这样先实现一个版本吧，以后再调整。</command-args>" } },
  { uuid: "706f0315-5a39-4ddb-af27-46920d9fc9f6", parentUuid: "76daf7a6-7627-43f9-8d70-022fe70111ad", type: "user",
    timestamp: "2026-09-06T17:32:24.308Z", promptId: "64174e43-de5b-4fa9-9d8c-41f8f18f14fc", userType: "external", isMeta: true, turnCompanion: true,
    message: { role: "user", content: [{ type: "text", text: "[redacted skill body]" }] } },
  { uuid: "a94c3af6-7729-4446-9f41-749d37dba728", parentUuid: "706f0315-5a39-4ddb-af27-46920d9fc9f6", type: "attachment",
    timestamp: "2026-09-06T17:32:24.308Z", userType: "external" },
  { uuid: "4a7f63e3-3d1b-4ea4-abac-89edf4cd286a", parentUuid: "a94c3af6-7729-4446-9f41-749d37dba728", type: "attachment",
    timestamp: "2026-09-06T17:32:24.601Z", userType: "external" },
  { uuid: "d94f596d-76c6-4fcf-921f-4a2fa4103e95", parentUuid: "4a7f63e3-3d1b-4ea4-abac-89edf4cd286a", type: "assistant",
    timestamp: "2026-09-06T17:32:37.730Z", userType: "external", message: { role: "assistant", content: [{ type: "thinking", thinking: "[redacted thinking]" }] } },
  { uuid: "431be203-fb8e-44b4-9c21-b714d748cc5c", parentUuid: "d94f596d-76c6-4fcf-921f-4a2fa4103e95", type: "assistant",
    timestamp: "2026-09-06T17:32:46.686Z", userType: "external", message: { role: "assistant", content: [{ type: "text", text: "[redacted reply]" }] } },
];

export const modelThenTypedRecords: CcNativeRecord[] = [
  { uuid: "model-root", parentUuid: null, type: "user", timestamp: "2026-08-19T10:01:05.000Z", promptSource: "sdk",
    message: { role: "user", content: "fixture root" } },
  { uuid: "adfb1f65-bdbb-4c40-b83d-deb5eeee7648", parentUuid: "model-root", type: "assistant", timestamp: "2026-08-19T10:01:06.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "fixture reply" }] } },
  { uuid: "b1ff24c1-7e25-4ce2-aae6-ae78fa6ca99b", parentUuid: "adfb1f65-bdbb-4c40-b83d-deb5eeee7648", type: "user",
    timestamp: "2026-08-19T10:01:06.889Z", isMeta: true, message: { role: "user", content: "<local-command-caveat>[redacted caveat]</local-command-caveat>" } },
  { uuid: "59eae9ff-f598-4359-be46-deb7588c5e3d", parentUuid: "b1ff24c1-7e25-4ce2-aae6-ae78fa6ca99b", type: "user",
    timestamp: "2026-08-19T10:01:06.888Z", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" } },
  { uuid: "807701c2-7226-4baf-8c3e-bfd6595e157e", parentUuid: "59eae9ff-f598-4359-be46-deb7588c5e3d", type: "user",
    timestamp: "2026-08-19T10:01:06.888Z", message: { role: "user", content: "<local-command-stdout>[redacted model output]</local-command-stdout>" } },
  { uuid: "6abc4870-0861-44bf-baed-33c8173bb7d1", parentUuid: "807701c2-7226-4baf-8c3e-bfd6595e157e", type: "user",
    timestamp: "2026-08-19T10:01:42.129Z", promptSource: "typed", origin: { kind: "human" },
    message: { role: "user", content: "pi-hermes-memory是什么，设计思想、社区评价如何" } },
  { uuid: "model-typed-reply", parentUuid: "6abc4870-0861-44bf-baed-33c8173bb7d1", type: "assistant", timestamp: "2026-08-19T10:01:43.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "[redacted reply]" }] } },
];

export const copyThenTypedRecords: CcNativeRecord[] = [
  { uuid: "copy-root", parentUuid: null, type: "user", timestamp: "2026-09-09T15:47:25.000Z", promptSource: "sdk",
    message: { role: "user", content: "fixture root" } },
  { uuid: "d528ce68-372d-46b3-a66a-2f0fe58101c9", parentUuid: "copy-root", type: "assistant", timestamp: "2026-09-09T15:47:26.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "fixture reply" }] } },
  { uuid: "14b3641f-ea65-45f7-8be6-6bb82bbfb396", parentUuid: "d528ce68-372d-46b3-a66a-2f0fe58101c9", type: "user",
    timestamp: "2026-09-09T15:47:27.172Z", isMeta: true, message: { role: "user", content: "<local-command-caveat>[redacted caveat]</local-command-caveat>" } },
  { uuid: "0e944555-1847-479d-887c-129890e136ca", parentUuid: "14b3641f-ea65-45f7-8be6-6bb82bbfb396", type: "user",
    timestamp: "2026-09-09T15:47:27.171Z", message: { role: "user", content: "<command-name>/copy</command-name>\n<command-message>copy</command-message>\n<command-args></command-args>" } },
  { uuid: "77214aa0-84b8-4871-836b-b56367be30f8", parentUuid: "0e944555-1847-479d-887c-129890e136ca", type: "user",
    timestamp: "2026-09-09T15:47:27.171Z", message: { role: "user", content: "<local-command-stdout>[redacted copy output]</local-command-stdout>" } },
  { uuid: "7d69b574-e463-4d3c-be2f-b43ceb5b32d6", parentUuid: "77214aa0-84b8-4871-836b-b56367be30f8", type: "user",
    timestamp: "2026-09-09T15:52:43.576Z", promptSource: "typed", origin: { kind: "human" },
    message: { role: "user", content: "GPT:拆分方向同意，但有两处不能直接照建议落地。" } },
  { uuid: "copy-typed-reply", parentUuid: "7d69b574-e463-4d3c-be2f-b43ceb5b32d6", type: "assistant", timestamp: "2026-09-09T15:52:44.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "[redacted reply]" }] } },
];
