import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { collectImageRefs } from '../src/executor.js'

describe('rc.2 tool result messages', () => {
  it('collects image attachments directly from tool-role content in event order', () => {
    const image = (id: string): ImageAttachmentRef => ({
      attachmentId: AttachmentId(id),
      mediaType: 'image/png',
      bytes: 12,
      width: 1,
      height: 1,
    })
    const first = image('first')
    const second = image('second')
    const events: SessionEvent<'tool/result'>[] = [first, second].map((attachment, index) => ({
      type: 'tool/result',
      seq: SessionSeq(index),
      time: 0,
      surfaceOp: 'append',
      data: {
        turn: 0,
        step: index,
        message: createToolResultMessage({
          callId: ToolCallId(`call-${index}`),
          isError: false,
          content: [
            { type: 'text', text: 'result' },
            { type: 'image', attachment },
          ],
        }),
      },
    }))
    expect(collectImageRefs(events)).toEqual([first, second])
  })
})
