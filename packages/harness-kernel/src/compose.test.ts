/**
 * Aceite E1 — composição declarativa em TS puro (m1-plano §2): a lista É o
 * arquivo de composição; a ordem é contrato porque inject resolve na montagem.
 */

import { describe, expect, it } from 'vitest'
import { Context } from './context.js'
import { compose } from './compose.js'

describe('compose', () => {
  it('monta as entries em ordem: provider antes de consumidor funciona', async () => {
    const { ctx, handles } = await compose([
      {
        plugin: (c: Context) => {
          c.provide('base', 10)
        },
      },
      {
        plugin: {
          name: 'consumidor',
          inject: ['base'],
          apply: (c: Context) => {
            c.provide('dobro', (c.get('base') as number) * 2)
          },
        },
      },
    ])
    expect(ctx.get('dobro')).toBe(20)
    expect(handles).toHaveLength(2)
    expect(handles.every((handle) => handle.status === 'active')).toBe(true)
  })

  it('consumidor antes do provider falha na montagem (a ordem é contrato)', async () => {
    await expect(
      compose([
        {
          plugin: {
            name: 'consumidor',
            inject: ['base'],
            apply: () => {},
          },
        },
        {
          plugin: (c: Context) => {
            c.provide('base', 10)
          },
        },
      ]),
    ).rejects.toThrow(/ausente/)
  })

  it('apply assíncrono é aguardado antes da próxima entry', async () => {
    const trilha: string[] = []
    await compose([
      {
        plugin: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
          trilha.push('primeira')
        },
      },
      {
        plugin: () => {
          trilha.push('segunda')
        },
      },
    ])
    expect(trilha).toEqual(['primeira', 'segunda'])
  })

  it('config viaja da entry para o apply', async () => {
    const { ctx } = await compose([
      {
        plugin: (c: Context, config: { valor: number }) => {
          c.provide('configurado', config.valor)
        },
        config: { valor: 7 },
      },
    ])
    expect(ctx.get('configurado')).toBe(7)
  })
})
