import { Response } from "express";

class ResponseHelper {
  public error(
    res: Response,
    data: { message: string; status: number; data?: any; [key: string]: any },
  ) {
    const { status, ...rest } = data;
    return res.status(status).json({
      success: false,
      ...rest,
    });
  }

  public success(
    res: Response,
    data: { status?: number; message?: string; data: any },
  ) {
    return res.status(data.status || 200).json({
      success: true,
      message: data.message || "Success",
      data: data.data,
    });
  }
}

export default new ResponseHelper();
