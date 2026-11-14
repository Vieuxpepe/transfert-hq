"""Read-only iCloud CalDAV discovery probe. No credentials or events are saved."""
from __future__ import annotations

import base64
import getpass
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

DAV = "{DAV:}"
CAL = "{urn:ietf:params:xml:ns:caldav}"
MAX_BYTES = 2 * 1024 * 1024


def apple_url(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not (host == "icloud.com" or host.endswith(".icloud.com")) or p.username or p.password or p.port not in (None, 443):
        raise ValueError("iCloud returned an untrusted URL")
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def propfind(url: str, user: str, password: str, body: bytes, depth: str = "0") -> tuple[str, ET.Element]:
    url = apple_url(url)
    auth = base64.b64encode((user + ":" + password).encode("utf-8")).decode("ascii")
    opener = urllib.request.build_opener(NoRedirect())
    for _ in range(6):
        req = urllib.request.Request(url, data=body, method="PROPFIND", headers={"Authorization": "Basic " + auth, "Content-Type": "application/xml; charset=utf-8", "Depth": depth})
        try:
            with opener.open(req, timeout=15) as response:
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ValueError("iCloud response is too large")
                return url, ET.fromstring(data)
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308) and error.headers.get("Location"):
                url = apple_url(urllib.parse.urljoin(url, error.headers["Location"]))
                continue
            if error.code == 401:
                raise ValueError("iCloud rejected the Apple Account or app-specific password (HTTP 401)") from None
            if error.code == 403:
                raise ValueError("iCloud denied calendar access (HTTP 403)") from None
            raise ValueError("iCloud request failed (HTTP %s)" % error.code) from None
    raise ValueError("Too many redirects")


def property_value(root: ET.Element, name: str) -> ET.Element | None:
    for propstat in root.iter(DAV + "propstat"):
        status = propstat.findtext(DAV + "status", "")
        if " 200 " not in status:
            continue
        prop = propstat.find(DAV + "prop")
        if prop is not None:
            value = prop.find(name)
            if value is not None:
                return value
    return None


def discover(user: str, password: str) -> list[str]:
    props = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>'
    base, root = propfind("https://caldav.icloud.com/", user, password, props)
    principal = property_value(root, DAV + "current-user-principal")
    href = principal.findtext(DAV + "href") if principal is not None else None
    if not href:
        raise ValueError("iCloud did not provide a calendar principal")
    principal_url = apple_url(urllib.parse.urljoin(base, href))
    props = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>'
    base, root = propfind(principal_url, user, password, props)
    home = property_value(root, CAL + "calendar-home-set")
    href = home.findtext(DAV + "href") if home is not None else None
    if not href:
        raise ValueError("iCloud did not provide a calendar home")
    home_url = apple_url(urllib.parse.urljoin(base, href))
    props = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>'
    _, root = propfind(home_url, user, password, props, "1")
    names = []
    for response in root.findall(DAV + "response"):
        resource = property_value(response, DAV + "resourcetype")
        if resource is None or resource.find(CAL + "calendar") is None:
            continue
        label = property_value(response, DAV + "displayname")
        names.append((label.text or "(unnamed)")[:120] if label is not None else "(unnamed)")
    return names


def main() -> int:
    print("iCloud calendar discovery: no credentials or events will be saved.")
    user = input("Apple Account email: ").strip()
    password = getpass.getpass("App-specific password (input hidden): ")
    if not user or not password:
        print("Email and app-specific password are required.")
        return 1
    try:
        calendars = discover(user, password)
    except (ValueError, urllib.error.URLError, OSError, ET.ParseError, TimeoutError) as error:
        print("Discovery failed: " + (str(error) if isinstance(error, ValueError) else "network or response error"))
        return 1
    print("Calendars visible to this account:")
    for name in calendars:
        print(" - " + name)
    if not calendars:
        print(" (none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
