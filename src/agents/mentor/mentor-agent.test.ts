import { describe, expect, it, vi } from "vitest";
import { buildMentorComparison } from "./mentor-agent.js";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("mentor-agent", () => {
  it("builds a dynamic mentor comparison from public knowledge sources", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wbsearchentities")) {
        return jsonResponse({
          search: [
            {
              id: "Q937",
              label: "Albert Einstein",
              description: "German-born theoretical physicist",
            },
          ],
        });
      }
      if (url.includes("Special:EntityData/Q937.json")) {
        return jsonResponse({
          entities: {
            Q937: {
              sitelinks: {
                enwiki: {
                  title: "Albert Einstein",
                },
              },
              claims: {
                P569: [{ mainsnak: { datavalue: { value: { time: "+1879-03-14T00:00:00Z" } } } }],
                P570: [{ mainsnak: { datavalue: { value: { time: "+1955-04-18T00:00:00Z" } } } }],
              },
            },
          },
        });
      }
      if (url.includes("/page/summary/Albert%20Einstein")) {
        return jsonResponse({
          title: "Albert Einstein",
          extract:
            "Albert Einstein developed the theory of relativity. He worked through repeated setbacks before broad acceptance.",
          content_urls: {
            desktop: {
              page: "https://en.wikipedia.org/wiki/Albert_Einstein",
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const comparison = await buildMentorComparison({
      objectiveIds: ["focus", "consistency"],
      state: {
        needs: {
          focus: 0.8,
        },
        affect: {
          frustration: 0.55,
          distress: 0.42,
          momentum: 0.33,
        },
      },
      fetchImpl: fetchMock,
    });

    expect(comparison.figure).toBe("Albert Einstein");
    expect(comparison.topic).toContain("focus");
    expect(comparison.sourceLinks.some((link) => link.includes("wikidata.org"))).toBe(true);
    expect(comparison.sourceLinks.some((link) => link.includes("wikipedia.org"))).toBe(true);
    expect(comparison.confidence).toBeGreaterThan(0.5);
  });

  it("falls back to evidence-backed comparison when external lookup fails", async () => {
    const comparison = await buildMentorComparison({
      objectiveIds: ["social-media-reduction"],
      state: {
        needs: {
          "social-media-reduction": 0.9,
        },
        affect: {
          frustration: 0.7,
          distress: 0.66,
          momentum: 0.22,
        },
      },
      evidence: [
        {
          topicId: "social-media-reduction",
          claim: "evidence",
          confidence: 0.71,
          references: [
            {
              title: "Behavior change trial",
              url: "https://pubmed.ncbi.nlm.nih.gov/11111111/",
              sourceType: "paper",
            },
          ],
        },
      ],
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("error", { status: 500 })),
    });

    expect(comparison.figure.toLowerCase()).toContain("evidence");
    expect(comparison.sourceLinks[0]).toContain("pubmed");
    expect(comparison.takeaway.toLowerCase()).toContain("measurable action");
  });
});
