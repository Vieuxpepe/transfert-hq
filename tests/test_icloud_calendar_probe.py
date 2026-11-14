"""Safety and discovery checks for the read-only iCloud probe."""
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET

from scripts import probe_icloud_calendar as probe


def response(inner):
    return ET.fromstring('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop>' + inner + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>')


class ICloudProbeTests(unittest.TestCase):
    def test_rejects_non_apple_or_insecure_redirects(self):
        for url in ('http://caldav.icloud.com/', 'https://icloud.com.evil.test/', 'https://evil.test/', 'https://user@icloud.com/', 'https://icloud.com:444/'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                probe.apple_url(url)
        self.assertEqual(probe.apple_url('https://p01-caldav.icloud.com/'), 'https://p01-caldav.icloud.com/')

    def test_discovery_lists_calendars_only(self):
        results = [
            ('https://caldav.icloud.com/', response('<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>')),
            ('https://caldav.icloud.com/principal/', response('<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>')),
            ('https://caldav.icloud.com/home/', response('<d:displayname>Family</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>')),
        ]
        with patch.object(probe, 'propfind', side_effect=results) as request:
            self.assertEqual(probe.discover('user', 'secret'), ['Family'])
        self.assertEqual(request.call_args.args[-1], '1')

    def test_untrusted_principal_is_rejected_before_next_request(self):
        root = response('<d:current-user-principal><d:href>https://evil.test/</d:href></d:current-user-principal>')
        with patch.object(probe, 'propfind', return_value=('https://caldav.icloud.com/', root)) as request:
            with self.assertRaises(ValueError):
                probe.discover('user', 'secret')
            self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
