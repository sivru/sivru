def resolve_route(message):
    """
    @sivru
    schema: 1
    role: routing-brain
    responsibility: resolve which solution owns an inbound message
    collaborators: [SolutionRouteResolver, HookDispatcher]
    decisions:
      - chose: one central router, not per-channel routers
        because: channels must stay thin; routing logic in one place
        valid-while: no channel needs channel-specific routing state
        revisit-if: a channel must route differently from the others
    maturity: stable
    @end
    """
    return str(message)
