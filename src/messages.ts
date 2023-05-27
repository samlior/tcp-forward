// magical fixed close message
export const close = Buffer.from("__close");

// magical fixed ping message
export const ping = Buffer.from([0, 0, 1]);

// magical fixed pong message
export const pong = Buffer.from([0, 0, 2]);
