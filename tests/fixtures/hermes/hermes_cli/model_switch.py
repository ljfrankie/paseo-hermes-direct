from types import SimpleNamespace
def switch_model(raw_input, current_provider, current_model, current_base_url='', current_api_key='', is_global=False, explicit_provider='', user_providers=None, custom_providers=None):
    if raw_input=='invalid': return SimpleNamespace(success=False,error_message='fixture unknown model')
    return SimpleNamespace(success=True,new_model=raw_input,target_provider=explicit_provider or current_provider,api_key='',base_url='',api_mode='',runtime_capabilities={})
