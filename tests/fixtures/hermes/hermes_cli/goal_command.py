from types import SimpleNamespace

def dispatch_goal_command(mgr, arg, *, authorize_gate, last_user_message=None, render=None, progress=None):
    result=SimpleNamespace(output='',prompt=None,kickoff=False,clear_pending=None,error=False)
    if arg in {'','status'}: result.output=mgr.status_line()
    elif arg=='show': result.output=mgr.render_contract()
    elif arg=='pause': mgr.pause();result.output='Goal paused';result.clear_pending='pause'
    elif arg in {'clear','stop','done'}: mgr.clear();result.output='Goal cleared';result.clear_pending='clear'
    elif arg in {'resume','continue','unpause'}: mgr.resume();result.output='Goal resumed';result.prompt=mgr.next_continuation_prompt()
    elif arg.startswith('gate add '): result.error=True;result.output=authorize_gate() or 'Gate added'
    elif arg.startswith('wait '): mgr.wait_on(int(arg.split()[1]));result.output='Goal waiting'
    elif arg=='unwait': mgr.stop_waiting();result.output='Wait cleared'
    else:
        mgr.set(arg);result.output='Goal set';result.prompt='goal-start '+arg;result.kickoff=True
    return result
