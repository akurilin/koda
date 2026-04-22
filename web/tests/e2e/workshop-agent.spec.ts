import { expect, test, type APIRequestContext } from "@playwright/test";

test.skip(
  process.env.RUN_AGENT_QA !== "true",
  "Set RUN_AGENT_QA=true to run the real Anthropic QA flow.",
);

test("a user can workshop a paragraph and save the revised version", async ({
  page,
  request,
}) => {
  const testRunId = crypto.randomUUID();
  const createResponse = await request.post("/api/documents", {
    data: { testRunId },
  });
  const document = await createResponse.json();

  const targetBlockId = crypto.randomUUID();
  const originalText =
    "This is the QA seed paragraph that the workshop agent will replace.";
  const revisedText =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

  try {
    await appendParagraph(request, document.id, targetBlockId, originalText);

    await page.goto(`/documents/${document.id}`);
    const editorPane = page.getByTestId("editor-pane");
    await expect(editorPane.getByText(originalText)).toBeVisible();

    // Hover the block's outer wrapper so BlockNote reveals the side menu,
    // then click the hammer button that enters workshop mode. The button
    // surfaces the `label` prop via aria-label (see @blocknote/mantine's
    // SideMenuButton), so role-based targeting is stable across the
    // internal side-menu subtree rebuilds that make it hard to grab by
    // position.
    await page
      .locator(`[data-node-type="blockOuter"][data-id="${targetBlockId}"]`)
      .hover();
    await page.getByRole("button", { name: "Workshop this paragraph" }).click();

    await page.waitForURL(
      new RegExp(`/documents/${document.id}/workshop/${targetBlockId}`),
    );
    await expect(page.getByTestId("workshop-workspace")).toBeVisible();

    // Explicit instructions — the workshop agent must call proposeRewrite
    // with the exact string so the assertions below can match verbatim.
    await page
      .getByTestId("workshop-agent-input")
      .fill(
        [
          `Replace the paragraph with exactly this text: "${revisedText}"`,
          "Call the proposeRewrite tool with that exact string as a single text item and nothing else.",
        ].join("\n"),
      );
    await page.getByTestId("workshop-agent-send").click();

    // The tool-UI bubble flips to "Proposed a new version." only after a
    // successful proposeRewrite result lands, so it's the most reliable
    // "the agent produced a proposal" signal.
    await expect(
      page.getByTestId("workshop-tool-propose-rewrite"),
    ).toContainText("Proposed a new version.", { timeout: 90_000 });

    await expect(
      page.getByTestId("workshop-editor-pane").getByText(revisedText),
    ).toBeVisible();

    // Save pushes the revised block back to the main doc and navigates
    // back to `/documents/:id?focus=<blockId>&scrollY=<n>`.
    await page.getByTestId("workshop-save").click();
    await page.waitForURL(new RegExp(`/documents/${document.id}(\\?|$)`));

    await expect(editorPane.getByText(revisedText)).toBeVisible();
    await expect(editorPane.getByText(originalText)).toHaveCount(0);
  } finally {
    await request.delete(`/api/documents/${document.id}`);
  }
});

async function appendParagraph(
  request: APIRequestContext,
  documentId: string,
  blockId: string,
  text: string,
) {
  await request.post(`/api/documents/${documentId}/blocks`, {
    data: {
      blockJson: {
        id: blockId,
        type: "paragraph",
        props: {},
        content: [{ type: "text", text, styles: {} }],
        children: [],
      },
    },
  });
}
