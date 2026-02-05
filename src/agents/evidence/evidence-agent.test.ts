import { describe, expect, it, vi } from "vitest";
import { buildEvidenceFindings } from "./evidence-agent.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("evidence agent", () => {
  it("fetches, deduplicates, and scores evidence references", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openalex")) {
        return jsonResponse({
          results: [
            {
              display_name: "Sleep extension for adults: a meta-analysis",
              doi: "10.1000/sleep-meta",
              publication_year: 2024,
              cited_by_count: 120,
              type: "meta-analysis",
              primary_location: {
                landing_page_url: "https://pubmed.ncbi.nlm.nih.gov/40000001/",
              },
            },
            {
              display_name: "Sleep hygiene trial",
              doi: "10.1000/sleep-trial",
              publication_year: 2022,
              cited_by_count: 21,
              type: "article",
              primary_location: {
                landing_page_url: "https://doi.org/10.1000/sleep-trial",
              },
            },
          ],
        });
      }

      return jsonResponse({
        message: {
          items: [
            {
              title: ["Clinical guideline for sleep duration"],
              DOI: "10.1000/sleep-meta",
              URL: "https://doi.org/10.1000/sleep-meta",
              issued: {
                "date-parts": [[2023, 5, 1]],
              },
              "is-referenced-by-count": 55,
            },
          ],
        },
      });
    });

    const findings = await buildEvidenceFindings({
      topics: [{ query: "sleep quality" }],
      fetchImpl: fetchMock,
      now: new Date("2026-02-05T00:00:00.000Z"),
      maxReferencesPerTopic: 5,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].topicId).toBe("sleep-quality");
    expect(findings[0].confidence).toBeGreaterThan(0.55);
    expect(findings[0].references.length).toBeGreaterThan(0);
    expect(findings[0].references[0].url.startsWith("https://")).toBe(true);
    expect(new Set(findings[0].references.map((ref) => ref.url)).size).toBe(findings[0].references.length);
  });

  it("returns per-topic findings for multiple dynamic topics", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openalex")) {
        return jsonResponse({
          results: [
            {
              display_name: "Exercise adherence review",
              doi: "10.2000/exercise-review",
              publication_year: 2021,
              cited_by_count: 75,
              type: "review",
              primary_location: {
                landing_page_url: "https://doi.org/10.2000/exercise-review",
              },
            },
          ],
        });
      }
      return jsonResponse({
        message: {
          items: [],
        },
      });
    });

    const findings = await buildEvidenceFindings({
      topics: ["exercise adherence", "stress recovery"],
      fetchImpl: fetchMock,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0].topicId).toBe("exercise-adherence");
    expect(findings[1].topicId).toBe("stress-recovery");
  });

  it("degrades gracefully when providers fail", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("network unavailable");
    });

    const findings = await buildEvidenceFindings({
      topics: ["nicotine cessation"],
      fetchImpl: fetchMock,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].references).toEqual([]);
    expect(findings[0].confidence).toBe(0);
    expect(findings[0].claim.toLowerCase()).toContain("no retrievable evidence");
  });
});
