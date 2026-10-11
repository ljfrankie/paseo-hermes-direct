import importlib.util
import pathlib
import unittest

class SourceTest(unittest.TestCase):
    def test_native_source_has_no_acp_dependency(self):
        text = (pathlib.Path(__file__).parents[1] / 'server/hermes_bridge.py').read_text()
        self.assertNotIn('from acp', text)
        self.assertNotIn('import acp', text)
        compile(text, 'hermes_bridge.py', 'exec')
