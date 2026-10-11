def parse_model_input(raw, provider):
    if ':' in raw: return tuple(raw.split(':',1))
    return ('',raw)
