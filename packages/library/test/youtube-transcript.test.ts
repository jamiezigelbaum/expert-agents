import { describe, expect, test } from "bun:test";
import {
  EXTRACTION_ARGUMENTS,
  YOUTUBE_EXTRACTION_ARGUMENTS,
  looksLikeWatchPageScript,
  parseYoutubeTranscriptExtraction,
} from "../src/extraction.ts";

function record(extracted: Record<string, unknown>): string {
  return JSON.stringify({ input: {}, extracted, llm: null, summary: null });
}

describe("YouTube transcript extraction", () => {
  test("asks the extractor for its JSON record on top of the shared arguments", () => {
    expect(YOUTUBE_EXTRACTION_ARGUMENTS).toEqual([...EXTRACTION_ARGUMENTS, "--json"]);
  });

  test("keeps a caption transcript with its source and title", () => {
    const parsed = parseYoutubeTranscriptExtraction(record({
      title: " Fixture talk ",
      content: "Transcript:\nhello and welcome\n",
      transcriptSource: "captionTracks",
      transcriptCharacters: 17,
    }));
    expect(parsed).toEqual({
      ok: true,
      text: "Transcript:\nhello and welcome\n",
      transcriptSource: "captionTracks",
      title: "Fixture talk",
    });
  });

  test("refuses a record with no transcript, naming the extractor's reason", () => {
    const parsed = parseYoutubeTranscriptExtraction(record({
      content: "the video description",
      transcriptSource: "unavailable",
      transcriptCharacters: null,
      transcriptMetadata: { reason: "no_transcript_available" },
    }));
    expect(parsed).toEqual({
      ok: false,
      code: "youtube_transcript_unavailable",
      reason: "no transcript was obtained (no_transcript_available)",
    });
  });

  test("does not echo an unexpected reason string", () => {
    const parsed = parseYoutubeTranscriptExtraction(record({
      content: "x",
      transcriptSource: null,
      transcriptMetadata: { reason: "<script>ytcfg.set({})</script>" },
    }));
    expect(parsed).toMatchObject({ ok: false, reason: "no transcript was obtained (no transcript source)" });
  });

  test("refuses watch-page script even when the source says captions", () => {
    const script = 'ytcfg.set({"HL":"pt-PT"});var setMessage=function(m){};';
    const parsed = parseYoutubeTranscriptExtraction(record({
      content: script,
      transcriptSource: "captionTracks",
      transcriptCharacters: script.length,
    }));
    expect(parsed).toMatchObject({ ok: false, code: "youtube_transcript_page_script" });
    expect(JSON.stringify(parsed)).not.toContain("pt-PT");
  });

  test("refuses output that is not the JSON record", () => {
    expect(parseYoutubeTranscriptExtraction("Transcript:\nplain text")).toMatchObject({
      ok: false,
      code: "youtube_extraction_unreadable",
    });
    expect(parseYoutubeTranscriptExtraction("[]")).toMatchObject({ ok: false, code: "youtube_extraction_unreadable" });
  });

  test("player bootstrap markers are recognised and ordinary speech is not", () => {
    expect(looksLikeWatchPageScript("var ytInitialPlayerResponse = {};")).toBe(true);
    expect(looksLikeWatchPageScript("window.ytplayer = {};")).toBe(true);
    expect(looksLikeWatchPageScript("we set the config and the player starts")).toBe(false);
  });
});
