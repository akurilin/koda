import { expect, test } from "@playwright/test";

test("a user can replace a blank document with the demo article", async ({
  page,
  request,
}) => {
  const testRunId = crypto.randomUUID();
  const createResponse = await request.post("/api/documents", {
    data: {
      title: `qa_demo_${testRunId}`,
      testRunId,
    },
  });
  const document = await createResponse.json();

  try {
    await page.goto(`/documents/${document.id}`);

    const editorPane = page.getByTestId("editor-pane");
    await expect(
      editorPane.locator('[contenteditable="true"]').first(),
    ).toBeVisible();

    await page.getByTestId("demo-text-button").click();

    await expect(page.getByTestId("demo-dialog-title")).toHaveText(
      "Replace document with demo text?",
    );

    const syncResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/documents/${document.id}/blocks/sync`) &&
        response.request().method() === "PUT" &&
        response.ok(),
    );

    await page.getByTestId("demo-dialog-confirm").click();
    await syncResponsePromise;

    await expect(page.getByTestId("demo-dialog-title")).toHaveCount(0);
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    await expect(
      editorPane.getByRole("heading", { name: "The Code Nobody Reads" }),
    ).toBeVisible();
    await expect(
      editorPane.getByText("since the launch of Claude Code,"),
    ).toBeVisible();
    await expect(
      editorPane.getByText(
        "The code nobody reads might just be the code of the future.",
      ),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/documents/${document.id}`);
  }
});
