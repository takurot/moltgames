export type ActivateDeviceResult =
  | { success: true }
  | { success: false; code: string; message: string; retryable: boolean };

export interface ActivateDeviceParams {
  userCode: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  gatewayUrl: string;
}

export async function activateDevice(params: ActivateDeviceParams): Promise<ActivateDeviceResult> {
  const { userCode, idToken, refreshToken, expiresIn, gatewayUrl } = params;

  const response = await fetch(`${gatewayUrl}/v1/auth/device/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ userCode, refreshToken, expiresIn }),
  });

  if (response.status === 204) {
    return { success: true };
  }

  const body = (await response.json()) as {
    code?: string;
    message?: string;
    retryable?: boolean;
  };

  return {
    success: false,
    code: body.code ?? 'UNKNOWN_ERROR',
    message: body.message ?? 'Activation failed',
    retryable: body.retryable ?? false,
  };
}
