/**
 * Service worker da extensão NOMOS (MV3).
 *
 * DELIBERADAMENTE mínimo. O estado vivo mora no side panel enquanto ele está
 * aberto, e a FONTE DE VERDADE é sempre o runtime — o worker MV3 dorme depois
 * de ~30 s e qualquer estado guardado aqui seria uma segunda verdade que
 * envelhece sozinha. A regra da NOMOS Web vale aqui dobrada: a UI lê, não deduz.
 *
 * Este worker faz exatamente uma coisa: liga o ícone da barra ao painel.
 * `sidePanel.open()` exige gesto do usuário (Chrome 116+); o comportamento
 * openPanelOnActionClick é o gesto canônico.
 */
"use strict";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    /* Chromium sem suporte a side panel: o ícone simplesmente não abre nada,
       e o painel pode ser aberto pelo menu de extensões. Não há fallback que
       não seja pior (popup minúsculo mentindo que é um painel). */
  });
