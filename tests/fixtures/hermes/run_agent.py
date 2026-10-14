import time
from tools import terminal_tool
class AIAgent:
    def __init__(self, stream_delta_callback=None, reasoning_callback=None, tool_start_callback=None,
                 tool_complete_callback=None, cwd=None, session_db=None, model=None, provider=None, session_id=None, **kwargs):
        self.delta, self.reason, self.start, self.complete = stream_delta_callback, reasoning_callback, tool_start_callback, tool_complete_callback
        self.stopped = False
        self.pending_steer = []
        self.model = model
        self.provider = provider or 'fixture'
        self._session_db = session_db
        self.session_id = session_id or 'fixture'
        self.tools = [{'type':'function','function':{'name':'terminal','description':'fixture terminal'}}]
    def reset_session_state(self, previous_messages=None, old_session_id=None, carry_over_context=False):
        self.stopped = False
    def switch_model(self, new_model, new_provider, api_key='', base_url='', api_mode='', capabilities=None):
        if new_model == 'native-failure': raise RuntimeError('fixture native client rebuild failed')
        self.model, self.provider = new_model, new_provider
    def steer(self, text):
        self.pending_steer.append(text)
        return True
    def interrupt(self): self.stopped = True
    def run_conversation(self, user_message, conversation_history, **kwargs):
        self.stopped = False
        history = list(conversation_history or [])
        history.append({'role':'user','content': user_message})
        if user_message == 'crash':
            import os
            os._exit(23)
        if user_message == 'explode': raise RuntimeError('fixture exception')
        if user_message == 'error': return {'error':'fixture provider error','messages':history}
        if user_message == 'approval':
            self.start('tool-approval','terminal',{'command':'fixture dangerous'})
            result = terminal_tool._get_approval_callback()('fixture dangerous', 'fixture approval')
            self.complete('tool-approval','terminal',{},result)
        self.reason('checking ')
        self.reason('now')
        self.delta('first ')
        print('Hermes incidental stdout must not become protocol')
        time.sleep(0.05)
        self.delta('chunk')
        self.delta(None)
        self.start('tool-' + str(len(history)), 'terminal', {'command':'echo fixture'})
        self.complete('tool-' + str(len(history)), 'terminal', {}, 'fixture tool output')
        for text in self.pending_steer:
            history.append({'role':'user','content':text})
        self.pending_steer.clear()
        if isinstance(user_message, list):
            import json
            parts = ['vision ', json.dumps(user_message, ensure_ascii=False)]
        elif user_message == 'recall-images':
            count = sum(1 for m in history for p in (m.get('content') if isinstance(m.get('content'), list) else []) if p.get('type') == 'image_url')
            parts = ['recalled ', str(count)]
        else:
            parts = ['hello ', 'stream ', str(len(history))]
        for part in parts:
            if self.stopped: return {'messages':history, 'interrupted':True}
            self.delta(part)
            time.sleep(0.05 if user_message != 'slow' else 0.3)
        for text in self.pending_steer:
            history.append({'role':'user','content':text})
        self.pending_steer.clear()
        final = ''.join(parts)
        self.delta(None)
        history.append({'role':'assistant','content':final})
        return {'final_response':final,'messages':history}
