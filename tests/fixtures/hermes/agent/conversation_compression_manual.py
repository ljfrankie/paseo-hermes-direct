import time
from types import SimpleNamespace
AGGRESSIVE_UNSUPPORTED='--aggressive is not supported'
def parse_compress_args(raw_args): return SimpleNamespace(preview='--preview' in raw_args,aggressive='--aggressive' in raw_args)
def compress_now(agent, history, request, *, system_message=None, task_id='default', skip_without_window=False, snapshot_is_current=None):
    if not request.preview: time.sleep(0.1)
    if agent.stopped: raise RuntimeError('compression stopped')
    if system_message=='compression-failure': raise RuntimeError('fixture compression failure')
    return SimpleNamespace(status='preview' if request.preview else 'compressed',after_messages=list(history) if request.preview else list(history)[-2:],before_messages=list(history),request=request)
def render_compress_result(result): return ['Preview only' if result.status=='preview' else 'Compressed: '+str(len(result.before_messages))+' -> '+str(len(result.after_messages))]
