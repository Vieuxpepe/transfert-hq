import json, tempfile, time, unittest
from pathlib import Path
from unittest import mock
import hq_ai, hq_music, hq_music_studio, hq_musica_gifts as gifts

class GiftsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        hq_music.bind(root=self.root); gifts._drafting = False
    def tearDown(self):
        gifts._drafting = False; hq_music.reset_for_tests(); self.tmp.cleanup()
    def test_initial_delay_and_disable(self):
        with mock.patch.object(gifts, '_resources_available', return_value=True), mock.patch.object(gifts, 'request') as request:
            gifts.tick(self.root); request.assert_not_called()
            self.assertGreater(gifts._read()['next_attempt'], time.time()+6*24*3600)
            gifts.settings(False)
            state=gifts._read(); state['next_attempt']=0; gifts._write(state)
            gifts.tick(self.root); request.assert_not_called()
    def test_draft_respects_history_and_starts_local_job(self):
        response={'inspired':True,'title':'A spark','note':'Pour toi','prompt':'Industrial metal, female vocals, synth bass','lyrics':'[Verse]\nWe rise into the night','language':'en','bpm':145}
        profile={'preferred_genres':['metal'],'favorite_artists':['example'],'musical_patterns':[]}
        taste={'history_sharing':False,'loved':[{'title':'private song','artist':'someone'}],'banned_artists':[]}
        with mock.patch.object(hq_music,'get_profile',return_value=profile), mock.patch.object(hq_music,'get_taste',return_value=taste), mock.patch.object(hq_ai,'generate',return_value=(json.dumps(response),'model')) as generate, mock.patch.object(hq_music_studio,'start',return_value={'id':'a'*32}) as start:
            gifts._drafting=True; gifts._draft(self.root, False)
            self.assertNotIn('private song',str(generate.call_args))
            self.assertEqual(start.call_args.args[1]['prompt'],response['prompt'])
            self.assertEqual(start.call_args.kwargs['gift']['title'],'A spark')
            self.assertEqual(gifts._read()['state'],'generating')
    def test_no_inspiration_creates_no_song(self):
        with mock.patch.object(hq_music,'get_profile',return_value={}), mock.patch.object(hq_music,'get_taste',return_value={}), mock.patch.object(hq_ai,'generate',return_value=(json.dumps({'inspired':False}),'model')), mock.patch.object(hq_music_studio,'start') as start:
            gifts._drafting=True; gifts._draft(self.root, True)
            start.assert_not_called(); self.assertEqual(gifts._read()['state'],'idle')
    def test_rejects_invalid_lyrics(self):
        with mock.patch.object(hq_music,'get_profile',return_value={}), mock.patch.object(hq_music,'get_taste',return_value={}), mock.patch.object(hq_ai,'generate',return_value=(json.dumps({'inspired':True,'prompt':'metal','lyrics':'','title':'x','note':'x'}),'model')), mock.patch.object(hq_music_studio,'start') as start:
            gifts._drafting=True; gifts._draft(self.root, False)
            start.assert_not_called(); self.assertEqual(gifts._read()['state'],'failed')

if __name__ == '__main__': unittest.main()
