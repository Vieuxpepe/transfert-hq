export async function openSection(page, section) {
  let tab = page.locator(`.bottom-nav [data-nav="${section}"]`);
  await tab.waitFor({ state: "attached" });
  if (!(await tab.isVisible())) {
    if ((await page.locator("body").getAttribute("data-view")) !== "plus") {
      await page.locator('.bottom-nav [data-nav="plus"]').click();
    }
    tab = page.locator(`.hq-more-nav [data-view-link="${section}"]`);
  }
  await tab.click();
}
