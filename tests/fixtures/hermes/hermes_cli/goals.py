"""Controlled fixture of the native GoalManager contract, not a model judge."""
import json
from pathlib import Path
from types import SimpleNamespace
from hermes_constants import get_hermes_home
class GoalManager:
    def __init__(self, session_id, *, default_max_turns=20):
        self.path = get_hermes_home() / (session_id + '-goal.json')
        self.default_max_turns = default_max_turns
        self.state = SimpleNamespace(**json.loads(self.path.read_text())) if self.path.exists() else None
    def _save(self):
        if self.state: self.path.write_text(json.dumps(vars(self.state)))
        else: self.path.unlink(missing_ok=True)
    def is_active(self): return bool(self.state and self.state.status == 'active')
    def has_goal(self): return self.state is not None
    def set(self, goal, **kwargs):
        self.state = SimpleNamespace(goal=goal,status='active',turns_used=0,max_turns=self.default_max_turns,subgoals=[],pid=None)
        self._save()
        return self.state
    def pause(self, reason='user-paused'):
        if self.state: self.state.status='paused'; self._save()
        return self.state
    def resume(self, **kwargs):
        if self.state: self.state.status='active'; self.state.turns_used=0; self._save()
        return self.state
    def clear(self): self.state=None; self._save()
    def status_line(self): return str(vars(self.state)) if self.state else 'No goal set.'
    def render_contract(self): return 'fixture completion contract'
    def next_continuation_prompt(self): return 'goal-continue ' + self.state.goal if self.is_active() else None
    def evaluate_after_turn(self, last_response, *, user_initiated=True, background_processes=None, active_delegations=0):
        import time
        if self.is_waiting(): return {'should_continue':False,'message':'Goal waiting','continuation_prompt':None}
        if 'judge-slow' in self.state.goal: time.sleep(.25)
        self.state.turns_used+=1
        done=self.state.goal=='finish' and self.state.turns_used>=2
        blocked=self.state.goal=='blocked'
        self.state.status='done' if done else 'paused' if blocked or self.state.turns_used>=self.state.max_turns else 'active'
        self._save()
        return {'should_continue':self.is_active(),'continuation_prompt':self.next_continuation_prompt(),
                'message':'Goal achieved' if done else 'Goal blocked' if blocked else 'Goal continuing' if self.is_active() else 'Goal budget exhausted'}
    def add_subgoal(self, text):
        if not self.is_active(): raise RuntimeError('No active goal')
        self.state.subgoals.append(text);self._save();return text
    def remove_subgoal(self, index_1based):
        if index_1based<1: raise ValueError('invalid index')
        value=self.state.subgoals.pop(index_1based-1);self._save();return value
    def clear_subgoals(self):
        count=len(self.state.subgoals);self.state.subgoals=[];self._save();return count
    def render_subgoals(self): return '\n'.join(self.state.subgoals) if self.state else 'No goal set.'
    def is_waiting(self):
        if self.state and self.state.pid == 42 and not (get_hermes_home() / 'fixture-process-active').exists():
            self.state.pid=None;self._save()
        return bool(self.state and self.state.pid)
    def wait_on(self, pid, reason=''): self.state.pid=pid;self._save()
    def stop_waiting(self):
        had=self.is_waiting()
        if self.state: self.state.pid=None;self._save()
        return had

def last_user_message_content(history):
    return next((m['content'] for m in reversed(history) if m['role']=='user'), None)
def gather_background_processes(task_id=None, *, owner_task_id=None): return []

def count_active_delegations(session_id): return 0
