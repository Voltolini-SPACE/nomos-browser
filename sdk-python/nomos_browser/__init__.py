"""SDK Python do NOMOS Browser Runtime.

O navegador é um recurso da plataforma: o estado da navegação pertence ao
Runtime, não ao agente nem a este processo. Um cliente pode morrer e a sessão
continua viva — é por isso que existe :meth:`NomosBrowser.detached_session`.

Uso mínimo::

    from nomos_browser import NomosBrowser

    browser = NomosBrowser()
    session = browser.create_session()
    session.goto("https://example.com")
    session.click(text="Login")

Sessão de vida curta, fechando ao sair::

    with browser.create_session() as session:
        session.goto("https://example.com")
    # sessão FECHADA aqui (DELETE /sessions/:id)

Sessão que sobrevive ao bloco::

    with browser.detached_session() as session:
        session.goto("https://example.com")
        session_id = session.session_id
    # sessão VIVA aqui (POST /sessions/:id/detach); outro cliente pode dar attach

A assimetria entre os dois blocos é proposital e está documentada em
``NomosBrowser.detached_session``.

Só stdlib. Requer Python >= 3.11. Fala a API v1 descrita em ``docs/API.md`` e
tipada em ``packages/core/src/contract.ts``.
"""

from .client import (
    ACTION_TOOLS,
    API_PREFIX,
    CAPABILITY_NAMES,
    CONTRACT_VERSION,
    DEFAULT_BASE_URL,
    SCREENSHOT_SCOPES,
    SDK_VERSION,
    TARGET_FIELDS,
    VERIFICATION_KINDS,
    WAIT_CONDITIONS,
    ActionResponse,
    ActionTiming,
    NomosBrowser,
    Session,
    target,
    verification,
)
from .errors import (
    ACTION_ERROR_CODES,
    NomosBrowserError,
    NomosError,
    NomosHttpError,
    NomosProtocolError,
    NomosTransportError,
    SessionClosedError,
)

__version__ = SDK_VERSION

__all__ = [
    "ACTION_ERROR_CODES",
    "ACTION_TOOLS",
    "API_PREFIX",
    "CAPABILITY_NAMES",
    "CONTRACT_VERSION",
    "DEFAULT_BASE_URL",
    "SCREENSHOT_SCOPES",
    "SDK_VERSION",
    "TARGET_FIELDS",
    "VERIFICATION_KINDS",
    "WAIT_CONDITIONS",
    "ActionResponse",
    "ActionTiming",
    "NomosBrowser",
    "NomosBrowserError",
    "NomosError",
    "NomosHttpError",
    "NomosProtocolError",
    "NomosTransportError",
    "Session",
    "SessionClosedError",
    "__version__",
    "target",
    "verification",
]
