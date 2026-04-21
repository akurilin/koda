import { expect, test } from "@playwright/test";

test("a user can type and reload a multi-block document", async ({
  page,
  request,
}) => {
  const testRunId = crypto.randomUUID();
  const createResponse = await request.post("/api/documents", {
    data: { testRunId },
  });
  const document = await createResponse.json();

  try {
    await page.goto(`/documents/${document.id}`);

    const editor = page
      .locator('[data-testid="editor"] [contenteditable="true"]')
      .first();
    await expect(editor).toBeVisible();
    await editor.click();

    await page.keyboard.type("Working Title");
    await page.keyboard.press("Enter");
    await page.keyboard.type("This is the first QA paragraph.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("This is the second QA paragraph.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A final QA note for the editor.");

    await page.waitForResponse(
      (response) =>
        response.url().includes(`/api/documents/${document.id}/blocks/sync`) &&
        response.request().method() === "PUT" &&
        response.ok(),
    );

    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    await page.reload();

    await expect(page.getByText("Working Title")).toBeVisible();
    await expect(
      page.getByText("This is the first QA paragraph."),
    ).toBeVisible();
    await expect(
      page.getByText("This is the second QA paragraph."),
    ).toBeVisible();
    await expect(
      page.getByText("A final QA note for the editor."),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/documents/${document.id}`);
  }
});
