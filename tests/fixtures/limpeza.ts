// Remover uma árvore que um runtime acabou de largar.
//
// Nasceu de uma falha real na sala limpa da tag v0.3.0: `tests/ownership.test.ts`
// passou nos 11 testes e ficou VERMELHO no `after()`, com
// `ENOTEMPTY, Directory not empty` num `rmSync(..., { recursive: true, force: true })`.
//
// `force: true` engole ENOENT, não ENOTEMPTY. ENOTEMPTY aqui significa que
// apareceu arquivo NOVO dentro de um diretório que a caminhada recursiva já
// tinha esvaziado — ou seja, alguém ainda estava escrevendo depois que o
// `close()` do daemon resolveu.
//
// A tentação é botar `maxRetries` e seguir a vida. Isso apaga a informação: se
// o runtime de fato continua escrevendo depois de dizer que fechou, esse é um
// defeito de PRODUTO, e o silêncio da retentativa o esconderia para sempre.
//
// Então aqui a retentativa existe, mas ela CONTA. Uma retentativa é ruído de
// sistema de arquivos. Muitas, ou uma demora longa, são sinal — e o chamador
// recebe o número para decidir. Nada é afirmado sobre a causa sem medição.

import { rmSync, existsSync } from "node:fs";

export interface ResultadoLimpeza {
  caminho: string;
  removido: boolean;
  tentativas: number;
  /** Erro da última tentativa, quando nem assim saiu. */
  ultimoErro: string | null;
}

/**
 * Remove `caminho` insistindo enquanto o erro for de corrida (ENOTEMPTY/EBUSY),
 * e relata quantas tentativas foram precisas.
 *
 * Não lança: quem chama decide o que fazer com o número. Um `after()` que
 * derruba a suíte por lixo em /tmp transforma higiene em falso vermelho.
 */
export function removerArvore(caminho: string, maxTentativas = 8): ResultadoLimpeza {
  let ultimoErro: string | null = null;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
    try {
      rmSync(caminho, { recursive: true, force: true });
      return { caminho, removido: !existsSync(caminho), tentativas: tentativa, ultimoErro: null };
    } catch (e) {
      const erro = e as NodeJS.ErrnoException;
      ultimoErro = `${erro.code ?? "?"}: ${erro.message}`;
      // Só insiste no que é corrida. EACCES ou EPERM não melhoram esperando, e
      // insistir neles só faz a suíte demorar para dar o mesmo erro.
      if (erro.code !== "ENOTEMPTY" && erro.code !== "EBUSY" && erro.code !== "EEXIST") {
        return { caminho, removido: false, tentativas: tentativa, ultimoErro };
      }
      // Espera curta e crescente. Bloqueante de propósito: isto roda em `after()`,
      // onde o event loop já não tem mais nada útil para fazer.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, tentativa * 25);
    }
  }

  return { caminho, removido: !existsSync(caminho), tentativas: maxTentativas, ultimoErro };
}

/**
 * Limpa várias árvores e escreve uma linha no stderr QUANDO precisou insistir.
 *
 * O aviso é o ponto: ele é a única forma de descobrir que um `close()` está
 * mentindo sobre ter terminado. Silêncio significa que saiu de primeira.
 */
export function limparArvores(...caminhos: string[]): ResultadoLimpeza[] {
  const rs = caminhos.map((c) => removerArvore(c));
  for (const r of rs) {
    if (r.tentativas > 1 || !r.removido) {
      process.stderr.write(
        `[limpeza] ${r.caminho}: ${r.tentativas} tentativa(s), removido=${r.removido}` +
          `${r.ultimoErro === null ? "" : `, ultimo erro ${r.ultimoErro}`}\n` +
          "[limpeza] insistir foi preciso: alguem escreveu DEPOIS do close(). " +
          "Se isso virar rotina, investigue o encerramento do runtime, nao a limpeza.\n",
      );
    }
  }
  return rs;
}
