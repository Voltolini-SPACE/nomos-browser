# NOMOS Browser (extensão) — justificativa de permissões

A lista abaixo é FIXADA por teste (`tests/extension-build.test.ts`): ampliar
qualquer item exige editar o teste, e é lá que essa conversa acontece.

| permissão | por quê | por que nada além |
|---|---|---|
| `sidePanel` | A extensão É um painel lateral (Chrome 116+). | — |
| `storage` | Guardar URL e token do runtime durante a sessão do navegador (`chrome.storage.session`; morre ao fechar). | Sem `storage.local` para o token: não deve sobreviver ao navegador. |
| `host_permissions: http://127.0.0.1/*`, `http://localhost/*` | Falar com o runtime NOMOS na máquina do usuário sem abrir CORS. | ZERO permissão de host em site real. O highlight na página é do RUNTIME (spotlight), por isso **não há content scripts** — e `<all_urls>` é proibido por asserção. |

Não usados, por contrato (também com asserção sobre o fonte): `tabs`,
`scripting`, `debugger`, `cookies`, `webNavigation` — autoridade paralela ao
runtime é exatamente o que a arquitetura proíbe. Toda ação passa pelo daemon
governado (política → autonomia → aprovação → auditoria).
