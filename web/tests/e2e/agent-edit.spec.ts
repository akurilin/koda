import { expect, test, type APIRequestContext } from "@playwright/test";

test.skip(
  process.env.RUN_AGENT_QA !== "true",
  "Set RUN_AGENT_QA=true to run the real Anthropic QA flow.",
);

test("the agent can make one precise block edit", async ({ page, request }) => {
  const testRunId = crypto.randomUUID();
  const createResponse = await request.post("/api/documents", {
    data: { testRunId },
  });
  const document = await createResponse.json();

  try {
    await appendBlock(
      request,
      document.id,
      "Alpha paragraph should stay unchanged.",
    );
    await appendBlock(
      request,
      document.id,
      "Replace this sentence with the approved QA sentence.",
    );
    await appendBlock(
      request,
      document.id,
      "Omega paragraph should stay unchanged.",
    );

    await page.goto(`/documents/${document.id}`);
    const editorPane = page.getByTestId("editor-pane");

    await expect(
      editorPane.getByText(
        "Replace this sentence with the approved QA sentence.",
      ),
    ).toBeVisible();

    await page
      .getByTestId("agent-input")
      .fill(
        [
          'Find the block that says "Replace this sentence with the approved QA sentence."',
          'Replace only that block with exactly "The agent successfully updated this QA paragraph."',
          "Do not edit any other block.",
        ].join("\n"),
      );
    await page.getByTestId("agent-send").click();

    await expect(
      editorPane.getByText("The agent successfully updated this QA paragraph."),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      editorPane.getByText(
        "Replace this sentence with the approved QA sentence.",
      ),
    ).toHaveCount(0);
    await expect(
      editorPane.getByText("Alpha paragraph should stay unchanged."),
    ).toBeVisible();
    await expect(
      editorPane.getByText("Omega paragraph should stay unchanged."),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/documents/${document.id}`);
  }
});

async function appendBlock(
  request: APIRequestContext,
  documentId: string,
  text: string,
) {
  await request.post(`/api/documents/${documentId}/blocks`, {
    data: {
      blockJson: {
        id: crypto.randomUUID(),
        type: "paragraph",
        props: {},
        content: [{ type: "text", text, styles: {} }],
        children: [],
      },
    },
  });
}
