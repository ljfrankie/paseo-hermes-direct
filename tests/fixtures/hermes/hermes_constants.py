import os
from pathlib import Path
def get_hermes_home(): return Path(os.environ['HERMES_HOME'])
def resolve_reasoning_config(config, model): return {}
