_callback = None
def _get_approval_callback(): return _callback
def set_approval_callback(cb):
    global _callback
    _callback = cb
