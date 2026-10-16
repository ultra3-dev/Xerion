# Revisión de Xerion 1.1.3

**Base:** Xerion 1.1.2, commit `3e56581f6919763f4480504ad1f8d6e0f139e538`.

## Cambio

El fallback de 1.1.2 mostraba texto normal para todos los usuarios fuera del caché de miembros, aunque su perfil se pudiera
resolver. Ahora la mención silenciosa se conserva si hay un miembro o un perfil de usuario válido en caché/API; solo se
usa texto cuando la API no puede resolver la cuenta.

Se mantienen `allowedMentions: { parse: [] }`, la supresión de notificaciones y el límite de consultas a los 10 resultados
visibles. No se cambian el ranking, la economía ni los datos guardados.

## Verificación

Las pruebas cubren mención de perfiles resueltos, fallback para perfiles no disponibles, paginación y bloqueo de pings.
No se verificó el resultado en un servidor de Discord real; el estado de producción de Render tampoco se confirmó.
