import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import hq_music_studio as studio

class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        python = self.root / 'ACE-Step-1.5' / '.venv' / 'Scripts' / 'python.exe'
        python.parent.mkdir(parents=True)
        python.touch()
        studio._active = None
    def tearDown(self):
        studio._active = None
        self.temp.cleanup()
    def test_validation_and_traversal(self):
        with self.assertRaises(studio.StudioError):
            studio.start(self.root, {'prompt': '', 'seed': 1})
        with self.assertRaises(studio.StudioError):
            studio.audio_path(self.root, '../escape')
        with self.assertRaises(studio.StudioError):
            studio.start(self.root, {'prompt':'metal', 'duration':121})
    def test_start_single_job_and_playback_status(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = lambda: None
        with mock.patch.object(studio.subprocess, 'Popen', return_value=process), mock.patch.object(studio.threading.Thread, 'start'):
            job = studio.start(self.root, {'prompt':'metal', 'lyrics':'hello', 'seed':42, 'duration':90, 'bpm':145})
            self.assertEqual(job['bpm'], 145)
            with self.assertRaises(studio.StudioError) as caught:
                studio.start(self.root, {'prompt':'another'})
            self.assertEqual(caught.exception.status, 409)
            folder = self.root / '.hq-music' / 'studio' / job['id']
            (folder / 'result.json').write_text(json.dumps({'status':'completed'}), encoding='utf-8')
            (folder / 'song.mp3').write_bytes(b'audio')
            self.assertEqual(studio.audio_path(self.root, job['id']).name, 'song.mp3')
            self.assertEqual(studio.list_jobs(self.root)[0]['status'], 'completed')

    def test_delete_only_moves_selected_finished_job(self):
        base = self.root / '.hq-music' / 'studio'
        first, other = 'a' * 32, 'b' * 32
        for ident in (first, other):
            folder = base / ident
            folder.mkdir(parents=True)
            (folder / 'job.json').write_text(json.dumps({'id': ident, 'status':'running'}), encoding='utf-8')
            (folder / 'result.json').write_text(json.dumps({'status':'completed'}), encoding='utf-8')
            (folder / 'song.mp3').write_bytes(b'music')
        self.assertTrue(studio.delete(self.root, first)['trashed'])
        self.assertFalse((base / first).exists())
        self.assertTrue((base / other / 'song.mp3').is_file())
        self.assertEqual((self.root / '.hq-music' / 'studio-trash' / first / 'song.mp3').read_bytes(), b'music')
        with self.assertRaises(studio.StudioError):
            studio.delete(self.root, '../outside')

    def test_delete_rejects_running_job(self):
        ident = 'c' * 32
        folder = self.root / '.hq-music' / 'studio' / ident
        folder.mkdir(parents=True)
        (folder / 'job.json').write_text(json.dumps({'id':ident, 'status':'running'}), encoding='utf-8')
        with self.assertRaises(studio.StudioError) as caught:
            studio.delete(self.root, ident)
        self.assertEqual(caught.exception.status, 409)
        self.assertTrue(folder.exists())

if __name__ == '__main__': unittest.main()
