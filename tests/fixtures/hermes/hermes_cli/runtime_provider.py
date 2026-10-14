def resolve_runtime_provider(**kwargs): return {'provider': kwargs.get('requested') or 'fixture'}
