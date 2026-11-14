"""Navigate to an HQ section through its visible desktop or mobile control."""


def open_section(page, section, *, touch=False):
    tab = page.locator(f'.bottom-nav [data-nav="{section}"]')
    tab.wait_for(state="attached")
    if not tab.is_visible():
        more = page.locator('.bottom-nav [data-nav="plus"]')
        if page.locator("body").get_attribute("data-view") != "plus":
            (more.tap if touch else more.click)()
        tab = page.locator(f'.hq-more-nav [data-view-link="{section}"]')
    (tab.tap if touch else tab.click)()
