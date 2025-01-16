import { EnvBindings } from './types';

export async function view<T>(
	contract: string,
	method: string,
	args: Record<string, unknown>,
	env: EnvBindings
): Promise<T> {
	return viewWithNode(env.NODE_URL, contract, method, args);
}

export async function viewWithNode<T>(
	node: string,
	contract: string,
	method: string,
	args: Record<string, unknown>
): Promise<T> {
	try {
		const res = await fetch(node, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'dontcare',
				method: 'query',
				params: {
					request_type: 'call_function',
					finality: 'final',
					account_id: contract,
					method_name: method,
					args_base64: btoa(JSON.stringify(args))
				}
			})
		});

		if (!res.ok) {
			const text = await res.text();
			console.error('[view]: HTTP Error', res.status, text);
			throw new Error(`HTTP error: ${res.status}`);
		}

		let json;
		try {
			json = await res.json<{ error: { data: string } } | { result: { result: Uint8Array } }>();
		} catch (error) {
			console.error('[view]: JSON Parse Error', error);
			const text = await res.text();
			console.error('[view]: Response Text', text);
			throw new Error('Failed to parse RPC response');
		}

		if ('error' in json) {
			console.error('[view]: RPC Error', json.error.data);
			throw new Error(json.error.data);
		}

		const result = new Uint8Array(json.result.result);
		const decoder = new TextDecoder();
		const decoded = decoder.decode(result);

		try {
			return JSON.parse(decoded);
		} catch (error) {
			console.error('[view]: Result Parse Error', error);
			console.error('[view]: Result', decoded);
			throw new Error('Failed to parse contract response');
		}
	} catch (error: unknown) {
		console.error('[view]: Error', error);
		throw error;
	}
}
