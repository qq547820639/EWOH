export interface ExceptionAttachmentRef {
  id: string;
  filename: string;
  contentType: string;
}

export function buildExceptionBody(
  note: string,
  attachment?: ExceptionAttachmentRef | null,
): Record<string, unknown> {
  return {
    code: 'MOBILE_EXCEPTION',
    note,
    ...(attachment ? { attachments: [attachment] } : {}),
  };
}
